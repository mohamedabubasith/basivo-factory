// The knowledge base: project docs, ADRs and runbooks the agent searches when it needs them, never pushed.
// Each doc is Markdown, optionally with frontmatter:
//   title: Money handling
//   summary: How we round and store amounts        (shown in search results)
//   reviewed: 2026-10-01                            (when a human last confirmed it)
//   sources: [src/money.ts]                         (code it describes)
// A doc is flagged stale when it was never reviewed, was reviewed long ago, or its sources changed since review,
// the same idea as memory entries: knowledge is a hint the code can overrule.

import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitFrontmatter } from '@basivo-factory/core'
import { git } from './git.ts'
import { buildIndex } from './search.ts'

export const STALE_AFTER_DAYS = 180

export type KnowledgeDoc = {
  path: string
  title: string
  summary: string
  reviewed: string | null
  sources: string[]
  body: string
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [])

export function loadKnowledge(repoDir: string, globs: string[]): KnowledgeDoc[] {
  const paths = [...new Set(globs.flatMap(g => globSync(g, { cwd: repoDir })))].filter(p => p.endsWith('.md')).sort()
  return paths.map(path => {
    const { data, body } = splitFrontmatter(readFileSync(join(repoDir, path), 'utf8'))
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]
    const reviewed = data.reviewed instanceof Date ? data.reviewed.toISOString().slice(0, 10) : data.reviewed ? String(data.reviewed) : null
    return {
      path,
      title: String(data.title ?? heading ?? path),
      summary: String(data.summary ?? body.replace(/^#.*$/m, '').trim().slice(0, 200)),
      reviewed,
      sources: list(data.sources),
      body,
    }
  })
}

export function staleness(repoDir: string, doc: KnowledgeDoc, now: Date): string[] {
  if (!doc.reviewed) return ['never reviewed']
  const reviewedAt = new Date(`${doc.reviewed}T00:00:00Z`)
  if (Number.isNaN(reviewedAt.getTime())) return [`reviewed date "${doc.reviewed}" is not YYYY-MM-DD`]
  const why: string[] = []
  const days = Math.floor((now.getTime() - reviewedAt.getTime()) / 86_400_000)
  if (days > STALE_AFTER_DAYS) why.push(`reviewed ${days} days ago`)
  if (doc.sources.length) {
    const changed = git(repoDir, 'log', `--since=${doc.reviewed}`, '--name-only', '--format=', '--', ...doc.sources).split('\n').filter(Boolean)
    if (changed.length) why.push(`sources changed since review: ${[...new Set(changed)].join(', ')}`)
  }
  return why
}

export function searchKnowledge(repoDir: string, docs: KnowledgeDoc[], text: string, limit: number, now: Date) {
  const hits = buildIndex(docs.map((d, i) => ({ id: String(i), text: `${d.title} ${d.summary} ${d.body}` }))).search(text, limit)
  return hits.map(h => {
    const d = docs[Number(h.id)]!
    const why = staleness(repoDir, d, now)
    return { path: d.path, title: d.title, summary: d.summary.slice(0, 300), reviewed: d.reviewed, stale: why.length > 0, why }
  })
}

// A window of a doc, with line numbers, so the agent reads only the part it needs.
export function readKnowledge(doc: KnowledgeDoc, from: number, count: number) {
  const lines = doc.body.split('\n')
  const start = Math.max(1, from)
  const slice = lines.slice(start - 1, start - 1 + count).map((l, i) => `${start + i}: ${l}`)
  return { path: doc.path, totalLines: lines.length, text: slice.join('\n') }
}
