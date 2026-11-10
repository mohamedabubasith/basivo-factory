// What one review run knows before any model runs: the change, its diff, the team's rules and knowledge from
// the base branch, CI, and the deterministic checks. Produces the brief the finders start from.

import { mkdirSync, writeFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { dirname, join } from 'node:path'
import { estimateTokens, BRIEF_TOKEN_CAP } from '@basivo-factory/core'
import { ALWAYS_IGNORE, parseConfig, type ReviewConfig } from './config.ts'
import type { ChangeRequest, CiStatus, Forge } from './forge/types.ts'
import { buildHunkMap, changedLines, renderDiff, type FilePatch, type HunkMap } from './hunks.ts'
import type { Finding } from './schema.ts'

export type Context = {
  change: ChangeRequest
  files: FilePatch[]
  map: HunkMap
  config: ReviewConfig
  ci: CiStatus
  knowledgeDir: string | null // base-branch copy of .factory/knowledge, for the kb tools
  knowledgePaths: string[]
  diffFile: string
  notes: string[]
  checked: string[]
  secretFindings: Finding[]
}

export const KNOWLEDGE_DIR = '.factory/knowledge'
export const CONFIG_PATH = '.factory/review.md'

const ignored = (path: string, globs: string[]) => globs.some(g => matchesGlob(path, g))

// Secrets that must never be quoted back. The finding carries the path and line only.
const SECRETS: [string, RegExp][] = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['private key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/],
  ['password literal', /\b(password|passwd|secret)\s*[:=]\s*['"][^'"]{8,}['"]/i],
]

export function scanSecrets(map: HunkMap): Finding[] {
  const out: Finding[] = []
  for (const f of map.values()) {
    if (/\.(lock|snap|md|txt)$/.test(f.path) || /test|spec|fixture|example/i.test(f.path)) continue
    for (const l of f.lines) {
      if (l.kind !== 'add' || l.newLine === null) continue
      const hit = SECRETS.find(([, re]) => re.test(l.text))
      if (hit) out.push({ file: f.path, line: l.newLine, side: 'RIGHT', severity: 'security', claim: `Looks like a ${hit[0]} committed in code. Move it to a secret store and rotate it.`, evidence: '(redacted)', confidence: 0.9 })
    }
  }
  return out
}

// Keeps the biggest files until the change fits the cap; the note tells the reader what was left out.
function trimToCap(files: FilePatch[], map: HunkMap, cap: number): { files: FilePatch[]; note: string | null } {
  const total = changedLines(map)
  if (total <= cap) return { files, note: null }
  const sorted = [...files].sort((a, b) => (sizeOf(map, b)) - (sizeOf(map, a)))
  const kept: FilePatch[] = []
  let n = 0
  for (const f of sorted) {
    const s = sizeOf(map, f)
    if (n + s > cap && kept.length > 0) continue
    kept.push(f)
    n += s
  }
  return { files: kept, note: `The change has ${total} changed lines; only the ${kept.length} largest files (${n} lines) were reviewed. Smaller changes get a fuller review.` }
}
const sizeOf = (map: HunkMap, f: FilePatch) => (map.get(f.path)?.added ?? 0) + (map.get(f.path)?.deleted ?? 0)

export async function gather(forge: Forge, number: number, workDir: string, override: Partial<ReviewConfig> = {}): Promise<Context | { skipped: string; change: ChangeRequest }> {
  const change = await forge.change(number)
  const config = { ...parseConfig(await forge.fileAt(CONFIG_PATH, change.base.ref)), ...override }
  if (!change.open) return { skipped: 'the pull request is closed', change }
  if (change.draft) return { skipped: 'the pull request is a draft', change }
  if (change.authorIsBot && !config.review_bots) return { skipped: `the author ${change.author} is a bot (set review_bots: true to review these)`, change }

  const notes: string[] = []
  const checked: string[] = []
  const all = await forge.files(number)
  const globs = [...ALWAYS_IGNORE, ...config.ignore]
  let files = all.filter(f => !ignored(f.path, globs))
  if (files.length < all.length) notes.push(`${all.length - files.length} file(s) left out by the ignore rules (lockfiles, build output, configured globs).`)
  let map = buildHunkMap(files)
  const trimmed = trimToCap(files, map, config.max_changed_lines)
  if (trimmed.note) {
    notes.push(trimmed.note)
    files = trimmed.files
    map = buildHunkMap(files)
  }
  checked.push(`${files.length} file(s), ${changedLines(map)} changed line(s)`)

  const diffFile = join(workDir, 'change.diff')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(diffFile, renderDiff(map))

  // Knowledge from the base branch, staged where the kb tools can search it.
  const knowledgePaths = (await forge.listDir(KNOWLEDGE_DIR, change.base.ref)).filter(p => p.endsWith('.md'))
  let knowledgeDir: string | null = null
  if (knowledgePaths.length) {
    knowledgeDir = join(workDir, 'knowledge')
    for (const p of knowledgePaths) {
      const text = await forge.fileAt(p, change.base.ref)
      if (text === null) continue
      const target = join(knowledgeDir, p)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
    }
    checked.push(`${knowledgePaths.length} knowledge doc(s) from ${change.base.ref}`)
  }

  const ci = await forge.ciStatus(change.head.sha)
  checked.push(`CI: ${ci.detail}`)
  const secretFindings = scanSecrets(map)
  checked.push(secretFindings.length ? `secrets scan: ${secretFindings.length} hit(s)` : 'secrets scan: clean')

  return { change, files, map, config, ci, knowledgeDir, knowledgePaths, diffFile, notes, checked, secretFindings }
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

// The only pushed context: under 2k tokens, trusted parts first, the author's text fenced.
export function buildBrief(ctx: Context): string {
  const { change: c, map, config } = ctx
  const fileLines = [...map.values()].map(f => `- ${f.path}${f.previousPath ? ` (was ${f.previousPath})` : ''} +${f.added} -${f.deleted}${f.binary ? ' (binary)' : ''}`)
  const render = (bodyMax: number, fileCount: number) => [
    `Review ${c.url} (${c.head.ref} → ${c.base.ref}, head ${c.head.sha.slice(0, 7)}).`,
    `The unified diff is in ${ctx.diffFile}; read it with the Read tool, then open the changed files for context.`,
    `CI on the head commit: ${ctx.ci.detail}.`,
    config.rules ? `Team review rules:\n${cut(config.rules, 1500)}` : '',
    ctx.knowledgePaths.length ? `Project knowledge (search with kb_search, read with kb_read): ${ctx.knowledgePaths.map(p => p.replace(`${KNOWLEDGE_DIR}/`, '')).join(', ')}` : '',
    `Changed files (${fileLines.length}):`,
    ...fileLines.slice(0, fileCount),
    fileLines.length > fileCount ? `… and ${fileLines.length - fileCount} more in the diff` : '',
    '<untrusted label="author description">',
    cut(c.title, 200),
    cut(c.body, bodyMax),
    '</untrusted>',
  ].filter(Boolean).join('\n')
  for (const bodyMax of [1500, 600, 200]) {
    for (const count of [fileLines.length, 40, 15]) {
      const text = render(bodyMax, count)
      if (estimateTokens(text) <= BRIEF_TOKEN_CAP) return text
    }
  }
  return render(0, 10)
}
