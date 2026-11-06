// One dev attempt on one plan step: baseline → brief → agent → normalise its git state → protect the tests →
// commit → run the tests → stuck check → ledger. Pass or fail comes from running the command, never from the agent.

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentEnv, type RoleProfile } from '@basivo-factory/agents'
import {
  buildBrief, checkClaims, COUNTS_AS_ATTEMPT, estimateTokens, failureSignature, fileRunLog, MAX_ATTEMPTS, ROLES, roleLabel,
  AgentReport, type AgentResult, type AgentRunner, type Attempt, type ClaimCheck,
} from '@basivo-factory/core'
import { blobShas, git, headCommit, MemoryStore } from '@basivo-factory/memory'
import { runCommand, type CommandResult } from './run-command.ts'

const MEMORY_BIN = fileURLToPath(import.meta.resolve('@basivo-factory/memory/bin'))
const TEST_TIMEOUT_MS = 10 * 60_000

export type DevStepInput = {
  repoDir: string
  memoryRoot: string
  repo: string // owner/name
  ticket: string
  title: string
  step: { n: number; of: number; task: string; doneWhen: string; protect: string[] }
  attempt: number // monotonic attempt number
  roundAttempt: number // 1..MAX_ATTEMPTS within the current round; 1 runs the baseline check
  files: string[]
  runner: AgentRunner
  runnerName: string
  profile: RoleProfile // Sirius's profile from .factory/agents/sirius.md (loadProfile(repoDir, 'dev'))
  logDir: string
  limits?: { maxTurns: number; maxBudgetUsd: number; timeoutMs: number }
}

export type DevStepOutcome =
  // Nothing was spent: the run failed for a reason retrying later fixes (rate limit, plan quota, login).
  | { kind: 'retry_later'; reason: string; agent: AgentResult; briefTokens: number; logFile: string }
  | {
      kind: 'attempt'
      attempt: Attempt
      fatal: boolean // retrying cannot help: block the ticket now
      agent: AgentResult | null // null when the baseline check stopped the step before any agent ran
      claims: ClaimCheck | null
      briefTokens: number
      logFile: string
    }

const DEFAULT_LIMITS = { maxTurns: 30, maxBudgetUsd: 2, timeoutMs: 15 * 60_000 }
const COMMITTER = ['-c', 'user.name=basivo-factory', '-c', 'user.email=factory@users.noreply.github.com']

const lines = (out: string) => out.split('\n').filter(Boolean)

// Every path that differs from `base`: edits, deletions and both sides of a rename, plus new untracked files.
export function changedFiles(repoDir: string, base = 'HEAD'): string[] {
  const tracked = lines(git(repoDir, 'diff', '--name-only', '--no-renames', base))
  const untracked = lines(git(repoDir, 'ls-files', '--others', '--exclude-standard'))
  return [...new Set([...tracked, ...untracked])].sort()
}

export const isProtected = (path: string, protect: string[]) =>
  protect.some(p => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`))

const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text)

const testFailure = (t: CommandResult) =>
  t.timedOut ? `tests timed out after ${TEST_TIMEOUT_MS / 60_000} min. ${tail(t.output, 500)}`
  : t.signal ? `tests killed by ${t.signal}. ${tail(t.output, 500)}`
  : `tests exited ${t.code}. ${tail(t.output, 700)}`

export async function devStep(input: DevStepInput): Promise<DevStepOutcome> {
  const store = new MemoryStore(input.memoryRoot)
  // e.g. APP-12-s2-a3-sirius-claude.jsonl, logged as "Sirius (claude)"
  const run = `${input.ticket}-s${input.step.n}-a${input.attempt}-${ROLES.dev.star.toLowerCase()}-${input.runnerName}`
  const logFile = join(input.logDir, `${run}.jsonl`)
  const log = fileRunLog(logFile, run, roleLabel('dev', input.runnerName))
  const testEnv = agentEnv({}) // the step's tests are agent-written code: no pipeline secrets for them either
  const runTests = () => runCommand(input.step.doneWhen, { cwd: input.repoDir, env: testEnv, timeoutMs: TEST_TIMEOUT_MS })
  const base = headCommit(input.repoDir)
  const earlier = store.attempts(input.ticket).filter(a => a.step === input.step.n)

  const record = (fields: Partial<Attempt> & Pick<Attempt, 'result' | 'failureReason' | 'summary'>, changed: string[]): Attempt => {
    const attempt: Attempt = {
      ticket: input.ticket, step: input.step.n, attempt: input.attempt, commit: headCommit(input.repoDir),
      blobs: blobShas(input.repoDir, changed), testCommand: input.step.doneWhen, signature: null, exitCode: null,
      notes: null, filesChanged: changed, at: new Date().toISOString(), ...fields,
    }
    store.appendAttempt(attempt)
    store.settlePendingFacts(input.ticket, attempt.result === 'pass')
    return attempt
  }

  // A check that already passes before any change cannot tell whether the step got done.
  if (input.roundAttempt === 1 && earlier.length === 0) {
    const baseline = await runTests()
    log.write('tool_result', { name: 'baseline', command: input.step.doneWhen, exitCode: baseline.code, output: tail(baseline.output, 1500) })
    if (baseline.code === 0) {
      const failureReason = `"${input.step.doneWhen}" already passes before any change, so it cannot check this step; the plan needs a test that fails first`
      return { kind: 'attempt', attempt: record({ result: 'fail', failureReason, summary: 'stopped before running an agent', exitCode: 0 }, []), fatal: true, agent: null, claims: null, briefTokens: 0, logFile }
    }
  }

  const brief = buildBrief({
    ticket: input.ticket, title: input.title, step: input.step,
    attempt: { n: input.roundAttempt, of: MAX_ATTEMPTS },
    failures: earlier.filter(a => a.result === 'fail').map(a => a.failureReason ?? 'failed'),
    files: input.files, protectedPaths: input.step.protect,
  })
  log.write('text', { brief })

  const { profile } = input
  const memoryArgs = [MEMORY_BIN, '--root', input.memoryRoot, '--repo-dir', input.repoDir, '--repo', input.repo, '--ticket', input.ticket]
  const agent = await input.runner.run({
    role: 'dev', output: AgentReport, brief, cwd: input.repoDir, access: 'write', log,
    instructions: profile.instructions,
    skills: profile.skillRefs,
    mcpServers: {
      ...profile.mcpServers,
      'factory-memory': { command: process.execPath, args: [...memoryArgs, ...profile.knowledge.flatMap(g => ['--knowledge', g])] },
    },
    ...DEFAULT_LIMITS,
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    ...(profile.maxBudgetUsd ? { maxBudgetUsd: profile.maxBudgetUsd } : {}),
    ...input.limits,
  })

  // A rate limit or a lapsed login is not the agent's fault: drop any half-made change and keep the attempt.
  if (agent.errorClass && !COUNTS_AS_ATTEMPT.has(agent.errorClass)) {
    git(input.repoDir, 'reset', '-q', '--hard', base)
    git(input.repoDir, 'clean', '-qfd')
    store.settlePendingFacts(input.ticket, false)
    log.write('result', { retryLater: agent.errorClass })
    return { kind: 'retry_later', reason: `${agent.errorClass}: ${agent.error}`, agent, briefTokens: estimateTokens(brief), logFile }
  }

  // If the agent committed, reset, or moved HEAD itself, fold everything back onto `base` and check it from there.
  if (headCommit(input.repoDir) !== base) git(input.repoDir, 'reset', '-q', '--soft', base)
  let changed = changedFiles(input.repoDir, base)
  const claims = agent.report ? checkClaims(agent.report, changed) : null
  const reportFields = { summary: agent.report?.summary ?? `no report (${agent.error ?? 'unknown'})`, notes: agent.report?.notes ?? null }
  log.write('result', { changed, claims })

  const fail = (failureReason: string, extra: Partial<Attempt> = {}) => ({
    kind: 'attempt' as const, attempt: record({ result: 'fail', failureReason, ...reportFields, ...extra }, changed),
    fatal: false, agent, claims, briefTokens: estimateTokens(brief), logFile,
  })

  // The graded tests, plus the agents' own profiles, skills and knowledge: no agent rewrites its instructions.
  const touched = changed.filter(p => isProtected(p, [...input.step.protect, '.factory/']))
  if (touched.length) {
    git(input.repoDir, 'checkout', base, '--', ...touched.filter(p => lines(git(input.repoDir, 'ls-tree', '--name-only', base, '--', p)).length))
    git(input.repoDir, 'clean', '-qf', '--', ...touched)
    changed = changedFiles(input.repoDir, base)
    return fail(`edited the protected test files ${touched.join(', ')}; the edits were reverted. Make the code pass the tests as written.`)
  }
  if (changed.length === 0) return fail(agent.error ? `agent: ${agent.error}` : 'made no changes')

  try {
    git(input.repoDir, 'add', '-A')
    git(input.repoDir, ...COMMITTER, 'commit', '-q', '--no-verify', '-m', `${input.ticket} step ${input.step.n} attempt ${input.attempt}`)
  } catch (e) {
    return fail(`could not commit the changes: ${tail(String(e), 300)}`)
  }

  const test = await runTests()
  log.write('tool_result', { name: 'test', command: input.step.doneWhen, exitCode: test.code, signal: test.signal, timedOut: test.timedOut, output: tail(test.output, 1500) })
  if (test.code === 0) {
    const attempt = record({ result: 'pass', failureReason: null, exitCode: 0, ...reportFields }, changed)
    return { kind: 'attempt', attempt, fatal: false, agent, claims, briefTokens: estimateTokens(brief), logFile }
  }

  const signature = failureSignature(test.output)
  const previous = earlier.at(-1)
  const stuck = previous?.result === 'fail' && previous.signature === signature
  const reason = `${stuck ? `stuck: same failure as attempt ${previous!.attempt}. ` : ''}${agent.error ? `agent: ${agent.error}. ` : ''}${testFailure(test)}`
  const outcome = fail(reason, { signature, exitCode: test.code })
  return { ...outcome, fatal: stuck }
}
