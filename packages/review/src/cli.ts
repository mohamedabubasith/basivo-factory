#!/usr/bin/env node
// basivo-review: review one pull/merge request.
//   basivo-review run [--pr N] [--repo owner/name] [--repo-dir DIR] [--dry-run] [--json] [--out FILE]
//   basivo-review post FILE          post a saved result (what the terminal skill does after you say yes)
// On GitHub Actions the PR, repo and token come from the environment. Elsewhere pass --pr and set
// GH_TOKEN or GITHUB_TOKEN (the terminal skill fills these from `gh auth token`).

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runnerFor } from '@basivo-factory/agents'
import { githubForge } from './forge/github.ts'
import type { Forge } from './forge/types.ts'
import { post, renderTerminal, review, type RunOptions } from './run.ts'
import type { ReviewResult } from './schema.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    pr: { type: 'string' }, repo: { type: 'string' }, 'repo-dir': { type: 'string' }, 'log-dir': { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, out: { type: 'string' },
    'include-bots': { type: 'boolean', default: false },
  },
})
const [command, file] = positionals

function forgeFromEnv(): { forge: Forge; number: number | null } {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY
  if (!token) throw new Error('no GitHub token: set GH_TOKEN or GITHUB_TOKEN')
  if (!repo) throw new Error('no repository: pass --repo owner/name or set GITHUB_REPOSITORY')
  let number: number | null = values.pr ? Number(values.pr) : null
  if (number === null && process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH)) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) as { pull_request?: { number: number }; issue?: { number: number; pull_request?: unknown } }
    number = event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : null)
  }
  return { forge: githubForge({ token, repo }), number }
}

const memoryBin = (): string => process.env.BASIVO_REVIEW_MEMORY_BIN ?? new URL(import.meta.resolve('@basivo-factory/memory/bin')).pathname

if (command === 'run') {
  const { forge, number } = forgeFromEnv()
  if (!number) throw new Error('which pull request? pass --pr N')
  const workDir = mkdtempSync(join(tmpdir(), 'basivo-review-'))
  const opts: RunOptions = {
    forge, number, workDir, repoDir: values['repo-dir'] ? resolve(values['repo-dir']) : null,
    logDir: values['log-dir'] ? resolve(values['log-dir']) : (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, 'basivo-review-logs') : join(workDir, 'logs')),
    runner: (runtime, model) => runnerFor(runtime, model), memoryBin: memoryBin(), dryRun: values['dry-run'],
    configOverride: values['include-bots'] ? { review_bots: true } : {},
  }
  const result = await review(opts)
  if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2))
  if (values.json) console.log(JSON.stringify(result, null, 2))
  else console.log(renderTerminal(result))
  console.error(`logs: ${opts.logDir}`)
  if (!values['dry-run'] && !values.out) {
    const p = await post(forge, result)
    console.error(`posted ${p.posted} inline comment(s)${p.failed ? `, ${p.failed} could not be anchored` : ''}; summary: ${p.summaryUrl}`)
  }
} else if (command === 'post' && file) {
  const result = JSON.parse(readFileSync(file, 'utf8')) as ReviewResult
  const { forge } = forgeFromEnv()
  const p = await post(forge, result)
  console.log(`posted ${p.posted} inline comment(s)${p.failed ? `, ${p.failed} could not be anchored` : ''}; summary: ${p.summaryUrl}`)
} else {
  console.error('usage: basivo-review run [--pr N] [--repo owner/name] [--repo-dir DIR] [--dry-run] [--json] [--out FILE] | post FILE')
  process.exit(1)
}
