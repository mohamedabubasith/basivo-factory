// One dev attempt on one plan step: brief → agent → check its claims against git → commit → run the tests
// → write the attempt to the ledger. The test result comes from running the command, never from the agent.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildBrief, checkClaims, estimateTokens, fileRunLog, MAX_ATTEMPTS,
  type AgentResult, type AgentRunner, type Attempt, type ClaimCheck,
} from '@basivo-factory/core'
import { blobShas, git, headCommit, MemoryStore } from '@basivo-factory/memory'

const MEMORY_BIN = fileURLToPath(import.meta.resolve('@basivo-factory/memory/bin'))

export type DevStepInput = {
  repoDir: string
  memoryRoot: string
  repo: string // owner/name
  ticket: string
  title: string
  step: { n: number; of: number; task: string; doneWhen: string }
  attempt: number
  files: string[]
  runner: AgentRunner
  runnerName: string
  logDir: string
  limits?: { maxTurns: number; maxBudgetUsd: number; timeoutMs: number }
}

export type DevStepOutcome = {
  attempt: Attempt
  agent: AgentResult
  claims: ClaimCheck | null
  briefTokens: number
  logFile: string
  testOutput: string
}

const DEFAULT_LIMITS = { maxTurns: 30, maxBudgetUsd: 2, timeoutMs: 15 * 60_000 }

// Tracked edits and deletions plus new untracked files, relative to the repo root.
export function changedFiles(repoDir: string): string[] {
  const lines = (out: string) => out.split('\n').filter(Boolean)
  const tracked = lines(git(repoDir, 'diff', '--name-only', 'HEAD'))
  const untracked = lines(git(repoDir, 'ls-files', '--others', '--exclude-standard'))
  return [...new Set([...tracked, ...untracked])].sort()
}

// Keeps the end of the output, where test runners print the failure summary.
const tail = (text: string, max = 1500) => (text.length > max ? `…${text.slice(-max)}` : text)

export async function devStep(input: DevStepInput): Promise<DevStepOutcome> {
  const store = new MemoryStore(input.memoryRoot)
  const lastFailure =
    store.attempts(input.ticket).filter(a => a.step === input.step.n && a.result === 'fail').at(-1)?.failureReason ?? null
  const brief = buildBrief({
    ticket: input.ticket,
    title: input.title,
    step: input.step,
    attempt: { n: input.attempt, of: MAX_ATTEMPTS },
    lastFailure,
    files: input.files,
  })

  const run = `${input.ticket}-s${input.step.n}-a${input.attempt}-${input.runnerName}`
  const logFile = join(input.logDir, `${run}.jsonl`)
  const log = fileRunLog(logFile, run, input.runnerName)
  log.write('text', { brief })

  const agent = await input.runner.run({
    brief,
    cwd: input.repoDir,
    access: 'write',
    mcpServers: {
      'factory-memory': {
        command: process.execPath,
        args: [MEMORY_BIN, '--root', input.memoryRoot, '--repo-dir', input.repoDir, '--repo', input.repo],
      },
    },
    log,
    ...(input.limits ?? DEFAULT_LIMITS),
  })

  const changed = changedFiles(input.repoDir)
  const claims = agent.report ? checkClaims(agent.report, changed) : null
  log.write('result', { changed, claims })
  if (changed.length) {
    git(input.repoDir, 'add', '-A')
    git(input.repoDir, 'commit', '-q', '-m', `${input.ticket} step ${input.step.n} attempt ${input.attempt}`)
  }

  const test = spawnSync('sh', ['-c', input.step.doneWhen], { cwd: input.repoDir, encoding: 'utf8', timeout: 10 * 60_000 })
  const testOutput = `${test.stdout ?? ''}${test.stderr ?? ''}`
  const passed = test.status === 0
  log.write('tool_result', { name: 'test', command: input.step.doneWhen, exitCode: test.status, output: tail(testOutput) })

  const attempt: Attempt = {
    ticket: input.ticket,
    step: input.step.n,
    attempt: input.attempt,
    commit: headCommit(input.repoDir),
    blobs: blobShas(input.repoDir, changed),
    testCommand: input.step.doneWhen,
    result: passed ? 'pass' : 'fail',
    failureReason: passed ? null : tail(agent.error ? `agent: ${agent.error}. tests: ${testOutput}` : testOutput, 600),
    summary: agent.report?.summary ?? `no report (${agent.error ?? 'unknown'})`,
    at: new Date().toISOString(),
  }
  store.appendAttempt(attempt)
  return { attempt, agent, claims, briefTokens: estimateTokens(brief), logFile, testOutput }
}
