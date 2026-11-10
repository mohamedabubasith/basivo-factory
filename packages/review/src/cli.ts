#!/usr/bin/env node
// basivo-review: review one pull/merge request.
//   basivo-review run [--pr N] [--repo owner/name] [--repo-dir DIR] [--dry-run] [--json] [--out FILE]
//   basivo-review post FILE          post a saved result (what the terminal skill does after you say yes)
// On GitHub Actions the PR, repo and token come from the environment. Elsewhere pass --pr and set
// GH_TOKEN or GITHUB_TOKEN (the terminal skill fills these from `gh auth token`).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runnerFor } from '@basivo-factory/agents'
import { githubForge } from './forge/github.ts'
import { gitlabForge } from './forge/gitlab.ts'
import type { Forge } from './forge/types.ts'
import { setup } from './onboard.ts'
import { post, renderTerminal, review, type RunOptions } from './run.ts'
import type { ReviewResult } from './schema.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    pr: { type: 'string' }, repo: { type: 'string' }, 'repo-dir': { type: 'string' }, 'log-dir': { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, out: { type: 'string' },
    'include-bots': { type: 'boolean', default: false }, ci: { type: 'string' },
    gitlab: { type: 'boolean', default: false }, host: { type: 'string' },
    verifier: { type: 'string' }, 'verifier-model': { type: 'string' }, // try another verifier without editing .factory/review.md
  },
})
const [command, file] = positionals

// GitLab when the job runs on GitLab CI or a GitLab token is set; GitHub otherwise.
function forgeFromEnv(): { forge: Forge; number: number | null } {
  const onGitLab = values.gitlab || Boolean(process.env.GITLAB_CI) || (Boolean(process.env.GITLAB_TOKEN) && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN)
  if (onGitLab) {
    const token = process.env.GITLAB_TOKEN
    const project = values.repo ?? process.env.CI_PROJECT_PATH
    if (!token) throw new Error('no GitLab token: set GITLAB_TOKEN (a project access token with the api scope)')
    if (!project) throw new Error('no project: pass --repo group/name or run inside GitLab CI')
    const number = values.pr ? Number(values.pr) : process.env.CI_MERGE_REQUEST_IID ? Number(process.env.CI_MERGE_REQUEST_IID) : null
    return { forge: gitlabForge({ token, project, host: values.host ?? process.env.GITLAB_HOST ?? process.env.CI_SERVER_URL ?? 'https://gitlab.com' }), number }
  }
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
  // A checkout helps the agents search around the change, but only if it is at the pull request's head.
  let repoDir = values['repo-dir'] ? resolve(values['repo-dir']) : null
  if (repoDir) {
    const head = (await forge.change(number)).head.sha
    const local = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    if (local !== head) {
      console.error(`--repo-dir is at ${local.slice(0, 7)}, the pull request head is ${head.slice(0, 7)}: using the changed files at the head commit instead`)
      repoDir = null
    }
  }
  const opts: RunOptions = {
    forge, number, workDir, repoDir,
    logDir: values['log-dir'] ? resolve(values['log-dir']) : (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, 'basivo-review-logs') : join(workDir, 'logs')),
    runner: (runtime, model) => runnerFor(runtime, model), memoryBin: memoryBin(), dryRun: values['dry-run'],
    configOverride: {
      ...(values['include-bots'] ? { review_bots: true } : {}),
      ...(values.verifier === 'claude' || values.verifier === 'codex' ? { verifier: values.verifier } : {}),
      ...(values['verifier-model'] ? { verifier_model: values['verifier-model'] } : {}),
    },
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
} else if (command === 'setup') {
  // Teach the reviewer this repository: writes .factory/knowledge/*.md, .factory/review.md and, with --ci, the workflow.
  const repoDir = resolve(values['repo-dir'] ?? '.')
  const templates = new URL('../../../templates/', import.meta.url)
  const readTemplate = (p: string) => { try { return readFileSync(new URL(p, templates), 'utf8') } catch { return null } }
  const r = await setup({
    repoDir, runner: runnerFor('claude'), logDir: values['log-dir'] ? resolve(values['log-dir']) : null,
    ci: values.ci === 'github' || values.ci === 'gitlab' ? values.ci : null,
    reviewTemplate: readTemplate(values.ci === 'gitlab' ? 'review/gitlab-ci.yml' : 'review/github.yml'), readmeTemplate: readTemplate('repo/.factory/knowledge/README.md'), dryRun: values['dry-run'],
  })
  if (values.json) console.log(JSON.stringify(r, null, 2))
  else {
    console.log(`Repository: ${r.survey.files} files; main areas: ${r.survey.topFolders.slice(0, 8).join(', ')}`)
    console.log(r.written.length ? `Written:\n${r.written.map(p => `  ${p}`).join('\n')}` : 'Nothing written.')
    if (r.kept.length) console.log(`Kept as written by the team:\n${r.kept.map(p => `  ${p}`).join('\n')}`)
    if (r.reverted.length) console.log(`Reverted:\n${r.reverted.map(p => `  ${p}`).join('\n')}`)
    if (r.skipped.length) console.log(`Skipped:\n${r.skipped.map(p => `  ${p}`).join('\n')}`)
    for (const n of r.notes) console.log(`note: ${n}`)
    console.log(`${r.usage.runs} run(s), ~$${r.usage.costUsd.toFixed(2)}`)
  }
} else if (command === 'post' && file) {
  const result = JSON.parse(readFileSync(file, 'utf8')) as ReviewResult
  const { forge } = forgeFromEnv()
  const p = await post(forge, result)
  console.log(`posted ${p.posted} inline comment(s)${p.failed ? `, ${p.failed} could not be anchored` : ''}; summary: ${p.summaryUrl}`)
} else {
  console.error('usage: basivo-review run [--pr N] [--repo owner/name] [--repo-dir DIR] [--dry-run] [--json] [--out FILE] | post FILE | setup [--repo-dir DIR] [--ci github] [--dry-run]')
  process.exit(1)
}
