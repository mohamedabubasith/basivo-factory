// The pipeline's stages, one per CI job. Each reads what earlier jobs saved on the factory-memory branch,
// does its part, saves its results and usage back, and reports to the ticket.
//   Capella (intake) → Polaris (plan) → [approval gate] → Sirius (dev, Rigel tests each attempt) → Vega (review) → Arcturus (ship)

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfile, runnerFor, type RoleProfile } from '@basivo-factory/agents'
import {
  fileRunLog, initialState, MAX_STEPS, next, Plan, Review, ROLES, roleLabel, roundAttempt,
  type Role, type State,
} from '@basivo-factory/core'
import { commitAndPush, git, MemoryStore } from '@basivo-factory/memory'
import { z } from 'zod'
import { devStep } from './dev-step.ts'
import type { Tracker } from '@basivo-factory/core'
import type { GitHub } from './github.ts'
import { emit, jobSummary, usageRow, usageTable } from './report.ts'

const MEMORY_BIN = fileURLToPath(import.meta.resolve('@basivo-factory/memory/bin'))
const MEMORY_BRANCH = 'factory-memory'

export type StageContext = {
  key: string // ticket key: GH-12 (GitHub issue) or BL-7 (Jira)
  repo: string // owner/name
  repoDir: string
  memoryDir: string
  logDir: string
  tracker: Tracker // where the ticket lives: GitHub issues or Jira
  forge: GitHub // where the code lives: branches, pull requests, run links
  approveHint: string // how a person approves the plan with this tracker
  baseBranch: string
}

const TicketDoc = z.object({ key: z.string(), title: z.string(), description: z.string(), url: z.string() })
const branchFor = (key: string) => `factory/${key}`
const untrusted = (label: string, text: string, max: number) =>
  `<untrusted label="${label}">\n${text.length > max ? `${text.slice(0, max)}…` : text}\n</untrusted>`

// Checks out the memory branch next to the repo as a git worktree, creating the branch on first use.
export function openMemory(repoDir: string, memoryDir: string): MemoryStore {
  if (!existsSync(memoryDir)) {
    let remote = true
    try {
      git(repoDir, 'fetch', '-q', 'origin', MEMORY_BRANCH)
    } catch {
      remote = false
    }
    if (remote) git(repoDir, 'worktree', 'add', '-q', '-B', MEMORY_BRANCH, memoryDir, `origin/${MEMORY_BRANCH}`)
    else git(repoDir, 'worktree', 'add', '-q', '--orphan', '-b', MEMORY_BRANCH, memoryDir)
  }
  return new MemoryStore(memoryDir)
}

function save(ctx: StageContext, message: string) {
  commitAndPush(ctx.memoryDir, `${ctx.key}: ${message}`, { branch: MEMORY_BRANCH })
}

function memoryServer(ctx: StageContext, profile: RoleProfile) {
  return {
    ...profile.mcpServers,
    'factory-memory': {
      command: process.execPath,
      args: [MEMORY_BIN, '--root', ctx.memoryDir, '--repo-dir', ctx.repoDir, '--repo', ctx.repo, '--ticket', ctx.key,
        ...profile.knowledge.flatMap(g => ['--knowledge', g])],
    },
  }
}

// A read-only agent run (Polaris, Vega): one shot, structured output.
async function readOnlyRun<T>(ctx: StageContext, role: Role, output: z.ZodType<T>, brief: string) {
  const profile = loadProfile(ctx.repoDir, role)
  const run = `${ctx.key}-${ROLES[role].star.toLowerCase()}-${profile.runtime}`
  const logFile = join(ctx.logDir, `${run}.jsonl`)
  const log = fileRunLog(logFile, run, roleLabel(role, profile.runtime))
  log.write('text', { brief })
  const agent = await runnerFor(profile.runtime, profile.model).run({
    role, output, brief, cwd: ctx.repoDir, access: 'read-only', log,
    instructions: profile.instructions, skills: profile.skillRefs, mcpServers: memoryServer(ctx, profile),
    maxTurns: profile.maxTurns ?? 25, maxBudgetUsd: profile.maxBudgetUsd ?? 2, timeoutMs: 15 * 60_000,
  })
  return { agent, profile, logFile }
}

// Capella: takes the ticket in.
export async function intake(ctx: StageContext, store: MemoryStore) {
  const ticket = await ctx.tracker.get(ctx.key)
  store.writeDoc(ctx.key, 'ticket', ticket)
  await ctx.tracker.transition(ctx.key, 'in_progress')
  await ctx.tracker.comment(ctx.key, `**Capella** picked up this ticket. Polaris is planning it. [Follow the run](${ctx.forge.runUrl()})`)
  save(ctx, 'intake')
  jobSummary(`### Capella (intake)\nTicket [${ctx.key}](${ticket.url}): ${ticket.title}`)
}

// Polaris: splits the ticket into checkable steps.
export async function plan(ctx: StageContext, store: MemoryStore) {
  const ticket = store.readDoc(ctx.key, 'ticket', TicketDoc)
  const brief = [
    `Ticket ${ctx.key}: plan the work. At most ${MAX_STEPS} steps.`,
    untrusted('ticket title', ticket.title, 300),
    untrusted('ticket description', ticket.description, 6000),
  ].join('\n')
  const { agent, profile, logFile } = await readOnlyRun(ctx, 'plan', Plan, brief)
  const ok = agent.report !== null && agent.report.steps.length <= MAX_STEPS
  store.appendUsage(ctx.key, usageRow({ stage: 'plan', star: 'Polaris', runtime: profile.runtime, result: ok ? 'planned' : 'failed', agent, logFile }))
  if (!ok) {
    save(ctx, 'plan failed')
    await ctx.tracker.transition(ctx.key, 'blocked')
    await ctx.tracker.comment(ctx.key, `**Polaris** could not plan this ticket: ${agent.error ?? `the plan has more than ${MAX_STEPS} steps; split the ticket`}`)
    throw new Error(`plan failed: ${agent.error}`)
  }
  const p = agent.report!
  store.writeDoc(ctx.key, 'plan', p)
  save(ctx, 'plan')
  const steps = p.steps.map((s, i) => `${i + 1}. ${s.task}\n   - done when: \`${s.doneWhen}\`${s.protect.length ? `\n   - must not edit: ${s.protect.map(f => `\`${f}\``).join(', ')}` : ''}`).join('\n')
  await ctx.tracker.comment(ctx.key, `**Polaris** planned this ticket in ${p.steps.length} step${p.steps.length === 1 ? '' : 's'}.\n\n${p.summary}\n\n${steps}\n\n${ctx.approveHint}`)
  await ctx.tracker.transition(ctx.key, 'awaiting_approval')
  await emit(ctx.key, 'plan_posted', { summary: p.summary, steps: p.steps.map(s => ({ task: s.task, doneWhen: s.doneWhen })) })
  jobSummary(`### Polaris (plan)\n${p.summary}\n\n${steps}\n\n${usageTable(store.usage(ctx.key).filter(r => r.stage === 'plan'))}`)
}

// Sirius: builds every step, up to MAX_ATTEMPTS each; Rigel's test run inside devStep decides each attempt.
export async function dev(ctx: StageContext, store: MemoryStore) {
  const ticket = store.readDoc(ctx.key, 'ticket', TicketDoc)
  const p = store.readDoc(ctx.key, 'plan', Plan)
  const profile = loadProfile(ctx.repoDir, 'dev')
  const runner = runnerFor(profile.runtime, profile.model)
  const branch = branchFor(ctx.key)
  try {
    git(ctx.repoDir, 'fetch', '-q', 'origin', branch)
    git(ctx.repoDir, 'checkout', '-q', '-B', branch, `origin/${branch}`)
  } catch {
    git(ctx.repoDir, 'checkout', '-q', '-B', branch)
  }
  await ctx.tracker.transition(ctx.key, 'in_progress')

  let state: State = [{ type: 'intake_done' }, { type: 'plan_posted', steps: p.steps.length }, { type: 'approved' }]
    .reduce((s, e) => next(s, e as Parameters<typeof next>[1]), initialState)
  const done = new Set(store.attempts(ctx.key).filter(a => a.result === 'pass').map(a => a.step))
  while (state.stage === 'dev' && done.has(state.step)) state = next(next(state, { type: 'dev_done' }), { type: 'test_passed' })

  while (state.stage === 'dev') {
    const step = p.steps[state.step - 1]!
    const out = await devStep({
      repoDir: ctx.repoDir, memoryRoot: ctx.memoryDir, repo: ctx.repo, ticket: ctx.key, title: ticket.title,
      step: { n: state.step, of: p.steps.length, task: step.task, doneWhen: step.doneWhen, protect: step.protect },
      attempt: state.attempt, roundAttempt: roundAttempt(state).n, files: step.files,
      runner, runnerName: profile.runtime, profile, logDir: ctx.logDir,
    })
    if (out.kind === 'retry_later') {
      store.appendUsage(ctx.key, usageRow({ stage: 'dev', star: 'Sirius', runtime: profile.runtime, step: state.step, attempt: state.attempt, result: 'retry later', agent: out.agent, logFile: out.logFile }))
      save(ctx, `step ${state.step} attempt ${state.attempt} postponed`)
      await ctx.tracker.comment(ctx.key, `**Sirius** paused: ${out.reason}. Re-run the job to continue from step ${state.step}.`)
      throw new Error(out.reason)
    }
    const a = out.attempt
    store.appendUsage(ctx.key, usageRow({ stage: 'dev', star: 'Sirius', runtime: profile.runtime, step: a.step, attempt: a.attempt, result: a.result, agent: out.agent, logFile: out.logFile, honest: out.claims?.honest ?? null }))
    save(ctx, `step ${a.step} attempt ${a.attempt} ${a.result}`)
    if (a.result === 'pass') git(ctx.repoDir, 'push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`)
    await emit(ctx.key, 'attempt', { step: a.step, of: p.steps.length, attempt: a.attempt, result: a.result, failureReason: a.failureReason?.slice(0, 500) ?? null, honest: out.claims?.honest ?? null })
    console.log(`Sirius step ${a.step} attempt ${a.attempt}: ${a.result}${a.failureReason ? ` (${a.failureReason.slice(0, 200)})` : ''}`)
    state = next(next(state, { type: 'dev_done' }), a.result === 'pass' ? { type: 'test_passed' } : { type: 'test_failed', reason: a.failureReason ?? 'failed', fatal: out.fatal })
  }

  const table = usageTable(store.usage(ctx.key).filter(r => r.stage === 'dev'))
  if (state.stage === 'blocked') {
    await ctx.tracker.transition(ctx.key, 'blocked')
    await ctx.tracker.comment(ctx.key, `**Sirius** is blocked on step ${state.step}: ${p.steps[state.step - 1]!.task}\n\n${state.failures.map((f, i) => `${i + 1}. ${f.slice(0, 500)}`).join('\n')}\n\nA person needs to look. [Run](${ctx.forge.runUrl()})`)
    jobSummary(`### Sirius (dev): blocked on step ${state.step}\n\n${table}`)
    throw new Error(`blocked on step ${state.step}`)
  }
  jobSummary(`### Sirius (dev): all ${p.steps.length} steps pass\n\n${table}`)
}

// Vega: reviews the whole change against the plan.
export async function review(ctx: StageContext, store: MemoryStore) {
  const p = store.readDoc(ctx.key, 'plan', Plan)
  const branch = branchFor(ctx.key)
  git(ctx.repoDir, 'fetch', '-q', 'origin', branch, ctx.baseBranch)
  git(ctx.repoDir, 'checkout', '-q', '-B', branch, `origin/${branch}`)
  // The diff goes inside .git so a read-only agent can open it without access outside the repo.
  const diffFile = join(ctx.repoDir, '.git', 'factory', 'change.diff')
  mkdirSync(join(ctx.repoDir, '.git', 'factory'), { recursive: true })
  writeFileSync(diffFile, git(ctx.repoDir, 'diff', `origin/${ctx.baseBranch}...HEAD`))
  const changed = git(ctx.repoDir, 'diff', '--name-only', `origin/${ctx.baseBranch}...HEAD`)
  const brief = [
    `Ticket ${ctx.key}: review the change on branch ${branch} against its plan.`,
    `Plan: ${p.summary}`,
    ...p.steps.map((s, i) => `Step ${i + 1}: ${s.task} (done when: ${s.doneWhen})`),
    `Changed files:\n${changed}`,
    `The full diff is in ${diffFile}; read it with the Read tool.`,
  ].join('\n')
  const { agent, profile, logFile } = await readOnlyRun(ctx, 'review', Review, brief)
  store.appendUsage(ctx.key, usageRow({ stage: 'review', star: 'Vega', runtime: profile.runtime, result: agent.report?.verdict ?? 'failed', agent, logFile }))
  if (!agent.report) {
    save(ctx, 'review failed')
    throw new Error(`review failed: ${agent.error}`)
  }
  store.writeDoc(ctx.key, 'review', agent.report)
  save(ctx, `review ${agent.report.verdict}`)
  await emit(ctx.key, 'review', { verdict: agent.report.verdict, summary: agent.report.summary, findings: agent.report.findings.length })
  jobSummary(`### Vega (review): ${agent.report.verdict}\n${agent.report.summary}\n\n${findingsList(agent.report)}`)
}

const findingsList = (r: Review) =>
  r.findings.length ? r.findings.map(f => `- **${f.severity}** \`${f.file}${f.line ? `:${f.line}` : ''}\`: ${f.issue}`).join('\n') : '- No findings.'

// Arcturus: opens the PR with the full record and reports back to the ticket.
export async function ship(ctx: StageContext, store: MemoryStore) {
  const ticket = store.readDoc(ctx.key, 'ticket', TicketDoc)
  const p = store.readDoc(ctx.key, 'plan', Plan)
  const r = store.readDoc(ctx.key, 'review', Review)
  const attempts = store.attempts(ctx.key)
  const rows = store.usage(ctx.key)
  const steps = p.steps.map((s, i) => {
    const tries = attempts.filter(a => a.step === i + 1)
    return `${i + 1}. ${s.task}: passed on attempt ${tries.find(a => a.result === 'pass')?.attempt ?? '?'} of ${tries.length}`
  }).join('\n')
  const body = [
    ctx.key.startsWith('GH-') ? `Closes #${ctx.key.slice(3)}` : `Ticket: [${ctx.key}](${ticket.url})`,
    `## Plan (Polaris)\n${p.summary}\n\n${steps}`,
    `## Review (Vega): ${r.verdict}\n${r.summary}\n\n${findingsList(r)}`,
    `## Agent runs\n${usageTable(rows)}`,
    `Run logs are attached to [the workflow run](${ctx.forge.runUrl()}) as artifacts; memory is on the \`${MEMORY_BRANCH}\` branch.`,
  ].join('\n\n')
  const pr = await ctx.forge.openPullRequest({ head: branchFor(ctx.key), base: ctx.baseBranch, title: `${ticket.title} (${ctx.key})`, body })
  await ctx.tracker.transition(ctx.key, 'in_review')
  await emit(ctx.key, 'pr_opened', { url: pr.url, number: pr.number })
  await ctx.tracker.comment(ctx.key, `**Arcturus** opened ${pr.url}. Vega's verdict: **${r.verdict}**. ${rows.length} agent runs, $${rows.reduce((t, x) => t + (x.costUsd ?? 0), 0).toFixed(2)} estimated.`)
  jobSummary(`### Arcturus (ship)\n[Pull request #${pr.number}](${pr.url})\n\n${usageTable(rows)}`)
}

export const STAGES = { intake, plan, dev, review, ship } as const
