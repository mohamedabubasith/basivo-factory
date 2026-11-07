#!/usr/bin/env node
// What every CI job runs: `factory stage <name> --ticket <n>` for one pipeline stage.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { initialState, needsJob, next, type Event, type State } from '@basivo-factory/core'
import { git } from '@basivo-factory/memory'
import { github } from './github.ts'
import { jira, JIRA_KEY } from './jira.ts'
import { openMemory, STAGES } from './stages.ts'

const USAGE = `usage:
  factory next --state <file> --event '<json>'   apply one event; prints the new stage and whether it needs a job
  factory stage <intake|plan|dev|review|ship> --ticket <issue number | Jira key>
      env: GITHUB_TOKEN, GITHUB_REPOSITORY; optional FACTORY_REPO_DIR (default .), FACTORY_MEMORY_DIR, FACTORY_LOG_DIR
      Jira tickets: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { state: { type: 'string' }, event: { type: 'string' }, ticket: { type: 'string' } },
})

const [command, name] = positionals

if (command === 'next' && values.state && values.event) {
  let state: State = initialState
  try {
    state = JSON.parse(readFileSync(values.state, 'utf8')) as State
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e // a new ticket has no state file yet
  }
  const after = next(state, JSON.parse(values.event) as Event)
  writeFileSync(values.state, `${JSON.stringify(after, null, 2)}\n`)
  console.log(JSON.stringify({ stage: after.stage, needsJob: needsJob(after.stage) }))
} else if (command === 'stage' && name && name in STAGES && values.ticket) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env
  if (!token || !repo) throw new Error('stage needs GITHUB_TOKEN and GITHUB_REPOSITORY')
  const repoDir = resolve(process.env.FACTORY_REPO_DIR ?? '.')
  const memoryDir = resolve(process.env.FACTORY_MEMORY_DIR ?? `${repoDir}/../factory-memory`)
  const forge = github({ token, repo })
  // A Jira site configured means tickets are Jira keys (BL-7); otherwise GitHub issue numbers.
  const onJira = Boolean(JIRA_BASE_URL)
  if (onJira && (!JIRA_EMAIL || !JIRA_API_TOKEN)) throw new Error('JIRA_BASE_URL is set, so JIRA_EMAIL and JIRA_API_TOKEN are needed too')
  // The ticket arrives from outside (a Jira web request), and it becomes a branch name and file paths.
  if (onJira ? !JIRA_KEY.test(values.ticket) : !/^\d+$/.test(values.ticket)) throw new Error(`invalid ticket: ${values.ticket}`)
  const ctx = {
    key: onJira ? values.ticket : `GH-${values.ticket}`, repo, repoDir, memoryDir,
    logDir: resolve(process.env.FACTORY_LOG_DIR ?? `${repoDir}/../factory-logs`),
    tracker: onJira ? jira({ baseUrl: JIRA_BASE_URL!, email: JIRA_EMAIL!, token: JIRA_API_TOKEN! }) : forge,
    forge,
    approveHint: onJira
      ? 'Reply **/approve** on this ticket to start building, or describe what to change.'
      : `Approve the plan to start building: [review the run](${forge.runUrl()}) and click **Review deployments**.`,
    // The workflow passes the repo's default branch; a plain clone falls back to origin/HEAD.
    baseBranch: process.env.FACTORY_BASE_BRANCH ?? git(repoDir, 'rev-parse', '--abbrev-ref', 'origin/HEAD').replace(/^origin\//, ''),
  }
  await STAGES[name as keyof typeof STAGES](ctx, openMemory(repoDir, memoryDir))
} else {
  console.error(USAGE)
  process.exit(1)
}
