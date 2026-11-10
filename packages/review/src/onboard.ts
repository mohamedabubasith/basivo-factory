// `basivo-review setup`: teach the reviewer the project once. A survey of the repository (code, no model) is
// the only thing pushed to one bounded write run, which produces .factory/knowledge/*.md. Docs the team wrote
// by hand are never touched; generated docs are rewritten only when their sources changed.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { estimateTokens, fileRunLog, splitFrontmatter, type AgentRunner } from '@basivo-factory/core'
import { loadKnowledge, staleness } from '@basivo-factory/memory'
import { z } from 'zod'
import { DEFAULT_CONFIG_TEXT } from './config.ts'
import { KNOWLEDGE_DIR } from './context.ts'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

export const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs', 'pubspec.yaml', '*.csproj', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'compose.yaml']
const CI = /^(\.github\/workflows\/.*\.ya?ml|\.gitlab-ci\.ya?ml|Jenkinsfile|\.circleci\/.*|bitbucket-pipelines\.yml|azure-pipelines\.yml)$/
const DOCS = /(^|\/)(readme|contributing|architecture|adr|decisions?)[^/]*\.(md|rst|txt)$|^docs?\//i
const TOOLING = /^(\.eslintrc.*|eslint\.config\..*|\.prettierrc.*|biome\.json|tsconfig.*\.json|vitest\.config\..*|jest\.config\..*|pytest\.ini|setup\.cfg|tox\.ini|\.rubocop\.yml|\.golangci\.yml|ruff\.toml|\.editorconfig|\.pre-commit-config\.yaml)$/

export type Survey = { text: string; files: number; topFolders: string[] }

// Tree to depth 3 with counts, manifests, CI, docs and tooling: what a new engineer looks at first.
export function survey(paths: string[], read: (p: string) => string | null): Survey {
  const counts = new Map<string, number>()
  for (const p of paths) {
    const parts = p.split('/')
    for (let d = 1; d <= Math.min(3, parts.length - 1); d++) {
      const key = parts.slice(0, d).join('/')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const tree = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).filter(([, n]) => n >= 2 || true)
    .map(([k, n]) => `${'  '.repeat(k.split('/').length - 1)}${k.split('/').pop()}/ (${n})`)
  const top = [...counts.entries()].filter(([k]) => !k.includes('/')).sort(([, a], [, b]) => b - a).map(([k]) => k)
  const rootFiles = paths.filter(p => !p.includes('/'))
  const manifests = paths.filter(p => MANIFESTS.some(m => m.startsWith('*') ? p.endsWith(m.slice(1)) : p === m || p.endsWith(`/${m}`))).slice(0, 12)
  const excerpt = (p: string, max: number) => {
    const t = read(p)
    return t === null ? '' : `--- ${p}\n${t.length > max ? `${t.slice(0, max)}\n…` : t}`
  }
  const lines = [
    `Repository survey: ${paths.length} tracked files.`,
    `Root files: ${rootFiles.join(', ')}`,
    `Folders (file counts, depth 3):`, ...tree.slice(0, 120),
    `CI: ${paths.filter(p => CI.test(p)).join(', ') || 'none found'}`,
    `Docs: ${paths.filter(p => DOCS.test(p)).slice(0, 40).join(', ') || 'none found'}`,
    `Tooling: ${paths.filter(p => TOOLING.test(p.split('/').pop() ?? '')).slice(0, 20).join(', ') || 'none found'}`,
    'Manifests:', ...manifests.map(m => excerpt(m, 1500)),
  ]
  let text = lines.join('\n')
  if (estimateTokens(text) > 4000) text = `${text.slice(0, 16_000)}\n… (survey cut at 4k tokens)`
  return { text, files: paths.length, topFolders: top }
}

export const REQUIRED_DOCS = ['overview.md', 'structure.md', 'conventions.md', 'testing.md', 'decisions.md']

const ONBOARD_PROMPT = `You document a code repository for an automated reviewer that will later read these docs instead of the
whole repository. Write Markdown files only inside ${KNOWLEDGE_DIR}/. Do not edit any other file, do not run git,
do not install anything.
Work from the survey first, then open the files you need (manifests, entry points, a few representative modules,
existing docs and ADRs). Do not read the whole repository; sample.
Every file you write starts with frontmatter:
---
title: <short title>
summary: <one sentence shown in search results>
reviewed: <today, YYYY-MM-DD>
sources: [<paths this doc describes, the ones a change would make it stale>]
generated: true
---
Write plainly, for a colleague who has never seen the code. Concrete paths, commands and names; no filler.
Rules about existing files: never modify or delete a file that lacks "generated: true" in its frontmatter; those
are the team's own notes. Rewrite a generated file only when told it is stale. Keep each file under 400 lines.`

export const OnboardReport = z.object({
  written: z.array(z.string()).describe('paths written, relative to the repository'),
  skipped: z.array(z.string()).describe('required docs you could not write, with the reason'),
  notes: z.string().max(1500),
})

export type SetupOptions = {
  repoDir: string
  runner: AgentRunner
  logDir: string | null
  ci: 'github' | 'gitlab' | null
  reviewTemplate: string | null // text of templates/review/github.yml when ci is github
  readmeTemplate: string | null // knowledge/README.md text for a repo that has none
  maxBudgetUsd?: number
  dryRun?: boolean // survey and plan only; no model, no files
  now?: () => Date
}

export type SetupResult = { written: string[]; kept: string[]; reverted: string[]; skipped: string[]; notes: string[]; survey: Survey; usage: { costUsd: number; runs: number } }

export async function setup(o: SetupOptions): Promise<SetupResult> {
  const repo = o.repoDir
  const today = (o.now?.() ?? new Date()).toISOString().slice(0, 10)
  const paths = git(repo, 'ls-files').split('\n').filter(Boolean)
  const read = (p: string) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : null)
  const s = survey(paths, read)

  // Existing knowledge: the team's docs are frozen; generated docs are refreshed only when stale.
  const existing = loadKnowledge(repo, [`${KNOWLEDGE_DIR}/**/*.md`])
  const team = existing.filter(d => !isGenerated(read(d.path) ?? ''))
  const generated = existing.filter(d => isGenerated(read(d.path) ?? ''))
  const stale = generated.filter(d => staleness(repo, d, o.now?.() ?? new Date()).length > 0)
  const fresh = generated.filter(d => !stale.includes(d))
  const missing = REQUIRED_DOCS.filter(name => !existing.some(d => d.path === `${KNOWLEDGE_DIR}/${name}`))
  const frozen = new Map(team.map(d => [d.path, read(d.path)!]))

  const notes: string[] = []
  const written: string[] = []
  let usage = { costUsd: 0, runs: 0 }

  // Files that need no model.
  const ensure = (path: string, text: string) => {
    if (existsSync(join(repo, path))) return
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    if (!o.dryRun) writeFileSync(join(repo, path), text)
    written.push(path)
  }
  ensure('.factory/review.md', DEFAULT_CONFIG_TEXT)
  if (o.readmeTemplate) ensure(`${KNOWLEDGE_DIR}/README.md`, o.readmeTemplate)
  if (o.ci === 'github' && o.reviewTemplate) ensure('.github/workflows/review.yml', o.reviewTemplate)

  const todo = [...missing.map(n => `${KNOWLEDGE_DIR}/${n}`), ...stale.map(d => d.path)]
  const areas = s.topFolders.filter(f => !['node_modules', '.github', '.factory', 'docs', 'dist', 'build', 'vendor'].includes(f)).slice(0, 8)
  if (todo.length === 0 && areas.every(a => existing.some(d => d.path === `${KNOWLEDGE_DIR}/areas/${a}.md`))) {
    notes.push('Knowledge is complete and up to date; nothing to generate.')
    return { written, kept: team.map(d => d.path), reverted: [], skipped: [], notes, survey: s, usage }
  }
  const areaDocs = areas.filter(a => !existing.some(d => d.path === `${KNOWLEDGE_DIR}/areas/${a}.md`))
  if (o.dryRun) {
    notes.push(`Would write: ${todo.join(', ')}${areaDocs.length ? ` and area docs for ${areaDocs.join(', ')}` : ''}.`)
    return { written, kept: team.map(d => d.path), reverted: [], skipped: [], notes, survey: s, usage }
  }

  const brief = [
    s.text,
    `Today is ${today}.`,
    `Write these files (missing or stale): ${todo.join(', ')}.`,
    areaDocs.length ? `Also write ${KNOWLEDGE_DIR}/areas/<area>.md for each of these areas (responsibilities, main modules, who calls whom, gotchas): ${areaDocs.join(', ')}.` : '',
    fresh.length ? `Up to date, leave as is: ${fresh.map(d => d.path).join(', ')}.` : '',
    team.length ? `Written by the team, never touch: ${team.map(d => d.path).join(', ')}. Link to them instead of repeating them.` : '',
    `What each required doc covers: overview.md = what the product is, stack, how to run and test (exact commands), entry points; structure.md = folder → purpose → key files table; conventions.md = naming, error handling, logging, API shapes, commit and branch rules found in config and code; testing.md = frameworks, layout, what a good test looks like here; decisions.md = existing ADRs and decision comments, linked not copied.`,
  ].filter(Boolean).join('\n\n')

  const before = git(repo, 'rev-parse', 'HEAD')
  const log = o.logDir ? fileRunLog(join(o.logDir, 'setup.jsonl'), 'setup', 'Vega (setup)') : undefined
  const r = await o.runner.run({
    role: 'dev', prompt: ONBOARD_PROMPT, output: OnboardReport, brief, cwd: repo, access: 'write', instructions: '', skills: [], mcpServers: {},
    maxTurns: 90, maxBudgetUsd: o.maxBudgetUsd ?? 4, timeoutMs: 20 * 60_000, log: log ?? { write() {} },
  })
  usage = { costUsd: r.usage.costUsd ?? 0, runs: 1 }
  if (r.error) notes.push(`The documentation run did not finish cleanly: ${r.error.slice(0, 300)}`)
  if (r.report?.notes) notes.push(r.report.notes)

  // Guard: undo anything outside the knowledge folder, any commit, and any change to a team doc.
  if (git(repo, 'rev-parse', 'HEAD') !== before) {
    git(repo, 'reset', '--soft', before)
    notes.push('The run committed; the commit was undone and the files kept.')
  }
  git(repo, 'reset', '-q') // unstage anything the run staged, so `checkout --` below restores from HEAD
  const reverted: string[] = []
  // Untrimmed: the first entry starts with a space when the file is unstaged (" M path").
  const raw = execFileSync('git', ['-C', repo, 'status', '--porcelain', '-z', '-uall'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const status = raw.split('\0').filter(Boolean).map(l => l.slice(3).split(' -> ').pop()!)
  for (const path of status) {
    const allowed = path.startsWith(`${KNOWLEDGE_DIR}/`) || path === '.factory/review.md' || path === '.github/workflows/review.yml'
    const teamDoc = frozen.has(path) && read(path) !== frozen.get(path)
    if (!allowed || teamDoc) {
      if (paths.includes(path)) git(repo, 'checkout', '--', path)
      else execFileSync('rm', ['-f', join(repo, path)])
      reverted.push(path)
    } else if (!written.includes(path)) written.push(path)
  }
  if (reverted.length) notes.push(`Reverted changes outside the knowledge folder or to team docs: ${reverted.join(', ')}.`)
  for (const d of team) if (frozen.has(d.path) && read(d.path) === frozen.get(d.path)) continue

  return { written, kept: team.map(d => d.path), reverted, skipped: r.report?.skipped ?? [], notes, survey: s, usage }
}

export const isGenerated = (text: string): boolean => splitFrontmatter(text).data.generated === true
