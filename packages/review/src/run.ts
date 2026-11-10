// One review, start to finish: gather → find (2 lenses) → pre-verify → verify → rank → (post).

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileRunLog, memoryRunLog, type AgentRunner, type McpServer, type RunLog, type Usage } from '@basivo-factory/core'
import { z } from 'zod'
import type { ReviewConfig } from './config.ts'
import { buildBrief, gather, type Context } from './context.ts'
import { FINGERPRINT_TAG, type Forge, type InlineComment } from './forge/types.ts'
import { fingerprint, preverify } from './preverify.ts'
import { LENSES, VERIFIER, type Lens } from './prompts.ts'
import { rank } from './rank.ts'
import { FinderReport, Verification, type Finding, type ReviewResult, type VerifiedFinding } from './schema.ts'

export type Runtime = 'claude' | 'codex'

export type RunOptions = {
  forge: Forge
  number: number
  workDir: string // temp dir for the diff file and the staged knowledge
  logDir: string | null // jsonl logs; null keeps them in memory
  repoDir: string | null // a checkout for the agents to search; null uses the staged head files only
  runner: (runtime: Runtime, model?: string) => AgentRunner
  memoryBin: string // path to the factory-memory MCP server entry (kb_search / kb_read)
  dryRun: boolean // do not consult or write anything on the host beyond reading
  configOverride?: Partial<ReviewConfig> // command-line overrides of .factory/review.md (for example review_bots)
}

export const SUMMARY_MARKER = '<!-- basivo-review:v1 -->'
const VERIFY_CONCURRENCY = 3

const zeroUsage = () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0 })
const addUsage = (t: ReturnType<typeof zeroUsage>, u: Usage) => {
  t.costUsd += u.costUsd ?? 0
  t.inputTokens += u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
  t.outputTokens += u.outputTokens
  t.runs += 1
}

export async function review(o: RunOptions): Promise<ReviewResult> {
  const got = await gather(o.forge, o.number, o.workDir, o.configOverride ?? {})
  const base = { forge: o.forge.kind, repo: o.forge.repo, number: o.number, headSha: got.change.head.sha, baseSha: got.change.base.sha }
  if ('skipped' in got) {
    return { ...base, verdict: 'ready_to_merge', inline: [], summaryOnly: [], dropped: [], notes: [], checked: [], ci: null, usage: zeroUsage(), skipped: got.skipped }
  }
  const ctx = got
  const usage = zeroUsage()
  const log = (name: string): RunLog => (o.logDir ? fileRunLog(join(o.logDir, `${o.forge.repo.replace('/', '-')}-${o.number}-${name}.jsonl`), name, 'Vega (review)') : memoryRunLog())
  const mcp: Record<string, McpServer> = ctx.knowledgeDir
    ? { 'factory-memory': { command: process.execPath, args: [o.memoryBin, '--root', join(o.workDir, 'memory'), '--repo-dir', ctx.knowledgeDir, '--repo', o.forge.repo, '--ticket', `PR-${o.number}`, '--knowledge', '**/*.md'] } }
    : {}
  if (ctx.knowledgeDir) mkdirSync(join(o.workDir, 'memory'), { recursive: true })
  const cwd = o.repoDir ?? (await stageHead(o, ctx))
  const brief = buildBrief(ctx)
  const model = ctx.config.model

  // Find: two lenses, fresh contexts, in parallel.
  const finders = await Promise.all((Object.keys(LENSES) as Lens[]).map(async lens => {
    const l = log(`find-${lens}`)
    l.write('text', { brief })
    const r = await o.runner(ctx.config.finders, model).run({
      role: 'review', prompt: LENSES[lens], output: FinderReport, brief, cwd, access: 'read-only', instructions: '', skills: [],
      mcpServers: mcp, maxTurns: 40, maxBudgetUsd: ctx.config.max_budget_usd / 3, timeoutMs: 12 * 60_000, log: l,
    })
    addUsage(usage, r.usage)
    if (r.error) ctx.notes.push(`The ${lens} pass did not finish: ${r.error.slice(0, 200)}`)
    return r.report ?? { findings: [], notes: '' }
  }))
  const candidates: Finding[] = finders.flatMap(f => f.findings)
  const finderNotes = finders.map(f => f.notes).filter(Boolean)

  // Pre-verify against the files at head (from the host, so it matches what will be commented on).
  const cache = new Map<string, string | null>()
  for (const f of candidates) if (!cache.has(f.file)) cache.set(f.file, await o.forge.fileAt(f.file, ctx.change.head.sha))
  const { kept, dropped } = preverify(candidates, ctx.map, p => cache.get(p) ?? null)

  // Already on the change from an earlier run on another push: do not repeat them.
  const posted = o.dryRun ? new Set<string>() : await o.forge.postedFingerprints(o.number)
  const fresh = kept.filter(f => {
    if (!posted.has(fingerprint(f))) return true
    dropped.push({ ...f, rejectedBy: null, rejectReason: 'already posted on an earlier push' })
    return false
  })

  // Verify each candidate in its own fresh context, a few at a time.
  const verifier = o.runner(ctx.config.verifier, model)
  const queue = [...fresh]
  const verified: VerifiedFinding[] = []
  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const l = log(`verify-${f.file.replace(/[^a-z0-9]+/gi, '_')}-${f.line}`)
      const r = await verifier.run({
        role: 'review', prompt: VERIFIER, output: Verification, cwd, access: 'read-only', instructions: '', skills: [], mcpServers: mcp,
        brief: [`Claim (${f.severity}): ${f.claim}`, `File: ${f.file}, line ${f.line} (${f.side === 'LEFT' ? 'removed line' : 'new code'})`, `Quoted code:\n${f.evidence}`,
          `The full diff is in ${ctx.diffFile}.`, ctx.config.rules ? `Team review rules:\n${ctx.config.rules.slice(0, 1200)}` : ''].filter(Boolean).join('\n'),
        maxTurns: 25, maxBudgetUsd: ctx.config.max_budget_usd / 6, timeoutMs: 8 * 60_000, log: l,
      })
      addUsage(usage, r.usage)
      verified.push({ ...f, verification: r.report })
      if (r.error) ctx.notes.push(`Verification of ${f.file}:${f.line} did not finish: ${r.error.slice(0, 200)}`)
    }
  }))

  // Deterministic findings skip the models: a pattern match is its own proof.
  for (const s of ctx.secretFindings) verified.push({ ...s, agreement: 1, rejectedBy: null, rejectReason: null, verification: { reasoning: 'pattern match', verdict: 'confirmed', confidence: 1 } })

  const ranked = rank(verified, ctx.config.rank)
  return {
    ...base, verdict: ranked.verdict, inline: ranked.inline, summaryOnly: ranked.summaryOnly, dropped: [...dropped, ...ranked.dropped],
    notes: [...ctx.notes, ...finderNotes], checked: ctx.checked, ci: ctx.ci.detail, usage, skipped: null,
  }
}

// Changed files at the head commit, so the agents can read them even without a checkout.
async function stageHead(o: RunOptions, ctx: Context): Promise<string> {
  const dir = join(o.workDir, 'head')
  const { writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  for (const f of ctx.files) {
    if (f.status === 'removed') continue
    const text = await o.forge.fileAt(f.path, ctx.change.head.sha)
    if (text === null) continue
    mkdirSync(dirname(join(dir, f.path)), { recursive: true })
    writeFileSync(join(dir, f.path), text)
  }
  return dir
}

// --- posting ---

const SEV_LABEL: Record<string, string> = { security: '🔒 Security', bug: '🐛 Bug', data: '🗄️ Data', decision: '📏 Decision', test: '🧪 Test' }

export const commentBody = (f: VerifiedFinding): string =>
  [`**${SEV_LABEL[f.severity] ?? f.severity}** · ${f.claim}`, f.evidence === '(redacted)' ? '' : `\`\`\`\n${f.evidence}\n\`\`\``,
    `<sub>confidence ${Math.round((f.verification?.confidence ?? f.confidence) * 100)}%${f.agreement > 1 ? ` · found by ${f.agreement} passes` : ''}</sub>`, FINGERPRINT_TAG(fingerprint(f))]
    .filter(Boolean).join('\n\n')

export function renderSummary(r: ReviewResult, failedInline: InlineComment[] = []): string {
  if (r.skipped) return `**basivo-review** skipped this change: ${r.skipped}.`
  const line = (f: VerifiedFinding) => `- \`${f.file}:${f.line}\` **${f.severity}** — ${f.claim}`
  const notPosted = [...r.summaryOnly, ...r.inline.filter(f => failedInline.some(c => c.path === f.file && c.line === f.line))]
  const postedInline = r.inline.filter(f => !failedInline.some(c => c.path === f.file && c.line === f.line))
  return [
    r.verdict === 'ready_to_merge' ? '## ✅ Ready to merge' : '## ⚠️ Needs changes',
    `Reviewed \`${r.headSha.slice(0, 7)}\` · ${postedInline.length} inline comment(s)${notPosted.length ? `, ${notPosted.length} more below` : ''} · ${r.dropped.length} candidate(s) dropped after verification`,
    notPosted.length ? `### Also found\n${notPosted.map(line).join('\n')}` : '',
    `### Checked\n${r.checked.map(c => `- ${c}`).join('\n')}`,
    r.notes.length ? `### Notes\n${r.notes.map(n => `- ${n}`).join('\n')}` : '',
    `<sub>${r.usage.runs} agent run(s), ${(r.usage.inputTokens / 1000).toFixed(1)}k tokens in / ${(r.usage.outputTokens / 1000).toFixed(1)}k out, ~$${r.usage.costUsd.toFixed(2)}. Findings were verified against the code before posting; a review with no findings is not a guarantee.</sub>`,
  ].filter(Boolean).join('\n\n')
}

export async function post(forge: Forge, r: ReviewResult): Promise<{ summaryUrl: string; posted: number; failed: number }> {
  const comments: InlineComment[] = r.inline.map(f => ({ path: f.file, line: f.line, side: f.side, body: commentBody(f) }))
  const result = r.skipped ? { posted: 0, failed: [] } : await forge.postInline(r.number, r.headSha, comments)
  const summaryUrl = await forge.upsertSummary(r.number, SUMMARY_MARKER, renderSummary(r, result.failed))
  return { summaryUrl, posted: result.posted, failed: result.failed.length }
}

// What a person sees in the terminal before deciding to post.
export function renderTerminal(r: ReviewResult): string {
  if (r.skipped) return `Skipped: ${r.skipped}`
  const rows = [...r.inline, ...r.summaryOnly].map(f => `${f.severity.padEnd(8)} ${f.file}:${f.line}  ${f.claim}`)
  return [
    `${r.verdict === 'ready_to_merge' ? 'READY TO MERGE' : 'NEEDS CHANGES'}  (${r.forge} ${r.repo}#${r.number} @ ${r.headSha.slice(0, 7)})`,
    rows.length ? rows.join('\n') : 'No verified findings.',
    `dropped after verification: ${r.dropped.length}`,
    ...r.notes.map(n => `note: ${n}`),
    `${r.usage.runs} runs, ${(r.usage.inputTokens / 1000).toFixed(1)}k in / ${(r.usage.outputTokens / 1000).toFixed(1)}k out, ~$${r.usage.costUsd.toFixed(2)}`,
  ].join('\n')
}

export const ReviewResultJson = z.custom<ReviewResult>(v => typeof v === 'object' && v !== null && 'verdict' in v)
