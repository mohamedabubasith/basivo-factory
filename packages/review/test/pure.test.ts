import { describe, expect, it } from 'vitest'
import { buildHunkMap, changedLines, evidenceExists, isTrivialEvidence, lineInDiff, locateEvidence, parsePatch, renderDiff } from '../src/hunks.ts'
import { fingerprint, preverify } from '../src/preverify.ts'
import { DEFAULT_RULES, rank } from '../src/rank.ts'
import type { Finding, VerifiedFinding } from '../src/schema.ts'

const PATCH = `@@ -1,5 +1,6 @@
 export function total(items, code) {
-  const sum = items.reduce((a, i) => a + i.price * i.qty, 0)
+  const sum = items.reduce((a, i) => a + Math.round(i.price * i.qty), 0)
+  if (code === 'SAVE10') return sum * 0.9
   return Math.round(sum * 100) / 100
 }
@@ -20,3 +21,4 @@
 export function lineTotal(item) {
   return item.price * item.qty
 }
+export const RATES = { SAVE10: 0.9 }`

const HEAD = `export function total(items, code) {
  const sum = items.reduce((a, i) => a + Math.round(i.price * i.qty), 0)
  if (code === 'SAVE10') return sum * 0.9
  return Math.round(sum * 100) / 100
}

const TAX = 0.2 // untouched by the change
${'\n'.repeat(13)}export function lineTotal(item) {
  return item.price * item.qty
}
export const RATES = { SAVE10: 0.9 }`

const files = [{ path: 'src/cart.js', previousPath: null, status: 'modified' as const, patch: PATCH }]

describe('hunk map', () => {
  it('numbers added, deleted and context lines on the right sides', () => {
    const lines = parsePatch(PATCH)
    expect(lines[0]).toMatchObject({ kind: 'ctx', oldLine: 1, newLine: 1 })
    expect(lines[1]).toMatchObject({ kind: 'del', oldLine: 2, newLine: null })
    expect(lines[2]).toMatchObject({ kind: 'add', oldLine: null, newLine: 2 })
    expect(lines[3]).toMatchObject({ kind: 'add', oldLine: null, newLine: 3 })
    expect(lines[4]).toMatchObject({ kind: 'ctx', oldLine: 3, newLine: 4 })
    expect(lines.at(-1)).toMatchObject({ kind: 'add', newLine: 24 })
  })
  it('knows which lines can carry a comment on each side', () => {
    const map = buildHunkMap(files)
    expect(lineInDiff(map, 'src/cart.js', 3, 'RIGHT')).toBe(true)
    expect(lineInDiff(map, 'src/cart.js', 2, 'LEFT')).toBe(true) // the deleted line
    expect(lineInDiff(map, 'src/cart.js', 10, 'RIGHT')).toBe(false) // between hunks
    expect(lineInDiff(map, 'other.js', 1, 'RIGHT')).toBe(false)
    expect(changedLines(map)).toBe(4)
  })
  it('handles binary and renamed files', () => {
    const map = buildHunkMap([
      { path: 'logo.png', previousPath: null, status: 'added', patch: null },
      { path: 'b.ts', previousPath: 'a.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-x\n+y' },
    ])
    expect(map.get('logo.png')!.binary).toBe(true)
    expect(map.get('b.ts')).toMatchObject({ previousPath: 'a.ts', added: 1, deleted: 1 })
    expect(renderDiff(map)).toContain('--- a.ts\n+++ b.ts')
  })
})

describe('evidence', () => {
  it('finds quotes regardless of whitespace and rejects quotes that are not there', () => {
    expect(evidenceExists(HEAD, "if (code === 'SAVE10')   return sum * 0.9")).toBe(true)
    expect(evidenceExists(HEAD, 'if (code === "SAVE10")')).toBe(false)
    expect(locateEvidence(HEAD, 'return sum * 0.9')).toBe(3)
  })
  it('calls short or structural quotes trivial', () => {
    for (const e of ['}', 'return', '  ', ');', 'end']) expect(isTrivialEvidence(e)).toBe(true)
    expect(isTrivialEvidence('return sum * 0.9')).toBe(false)
  })
})

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: 'src/cart.js', line: 3, side: 'RIGHT', severity: 'bug', claim: 'Discount skips the final rounding', evidence: 'return sum * 0.9', confidence: 0.8, ...over,
})

describe('preverify', () => {
  const map = buildHunkMap(files)
  const read = (p: string) => (p === 'src/cart.js' ? HEAD : null)

  it('keeps a finding whose evidence is in the file on a diff line', () => {
    const { kept, dropped } = preverify([finding()], map, read)
    expect(kept).toHaveLength(1)
    expect(dropped).toHaveLength(0)
  })
  it('drops findings outside the change, with invented quotes, or trivial evidence', () => {
    const { kept, dropped } = preverify([
      finding({ file: 'src/other.js' }),
      finding({ evidence: 'applyCoupon(code)' }),
      finding({ evidence: '}' }),
      finding({ line: 7, evidence: 'const TAX = 0.2' }), // real code, but not part of the change
    ], map, read)
    expect(kept).toHaveLength(0)
    expect(dropped.map(d => d.rejectReason)).toEqual([
      'file is not part of the change', 'quoted evidence is not in the file', 'evidence is too short to prove anything', 'line 7 is not in the diff',
    ])
  })
  it('moves a miscounted line to where the evidence really is', () => {
    const { kept } = preverify([finding({ line: 7 })], map, read)
    expect(kept[0]!.line).toBe(3)
  })
  it('merges the same spot from two passes and boosts confidence', () => {
    const { kept } = preverify([finding({ confidence: 0.6 }), finding({ line: 4, confidence: 0.7, claim: 'Discount is applied before the single rounding that ADR 0001 requires' })], map, read)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.agreement).toBe(2)
    expect(kept[0]!.confidence).toBeCloseTo(0.8)
    expect(kept[0]!.claim).toContain('ADR 0001')
  })
  it('merges two passes describing one problem under different severities, keeping the stronger one', () => {
    const { kept } = preverify([
      finding({ line: 3, severity: 'decision', claim: 'lineTotal rounds each line to cents, breaking ADR 0001: line totals stay unrounded, round once at the end' }),
      finding({ line: 4, severity: 'bug', claim: 'lineTotal now rounds per line, violating ADR 0001 (line totals stay unrounded, round once at the end)', evidence: 'return Math.round(sum * 100) / 100' }),
      finding({ line: 4, severity: 'test', claim: 'No test covers the SAVE10 path', evidence: 'return Math.round(sum * 100) / 100' }),
    ], map, read)
    expect(kept.map(k => [k.severity, k.agreement])).toEqual([['bug', 2], ['test', 1]])
  })
  it('accepts a deleted-line finding without reading the new file', () => {
    const { kept } = preverify([finding({ side: 'LEFT', line: 2, evidence: 'a + i.price * i.qty, 0)' })], map, () => null)
    expect(kept).toHaveLength(1)
  })
  it('fingerprints the same finding the same way across runs', () => {
    expect(fingerprint(finding())).toBe(fingerprint(finding({ line: 9, evidence: 'return  sum * 0.9 ' })))
    expect(fingerprint(finding())).not.toBe(fingerprint(finding({ severity: 'test' })))
  })
})

describe('rank', () => {
  const vf = (over: Partial<VerifiedFinding> & { verdict?: 'confirmed' | 'rejected' | 'uncertain'; vc?: number }): VerifiedFinding => {
    const { verdict = 'confirmed', vc = 0.9, ...rest } = over
    return { ...finding(), agreement: 1, rejectedBy: null, rejectReason: null, verification: { reasoning: 'checked', verdict, confidence: vc }, ...rest }
  }
  it('keeps confirmed findings, orders by severity, caps inline comments', () => {
    const r = rank([vf({ severity: 'test' }), vf({ severity: 'security' }), vf({ severity: 'bug' })], { ...DEFAULT_RULES, maxComments: 2 })
    expect(r.inline.map(f => f.severity)).toEqual(['security', 'bug'])
    expect(r.summaryOnly.map(f => f.severity)).toEqual(['test'])
    expect(r.verdict).toBe('needs_changes')
  })
  it('drops rejected and low-confidence uncertain findings', () => {
    const r = rank([vf({ verdict: 'rejected' }), vf({ verdict: 'uncertain', vc: 0.5 }), vf({ severity: 'test', verdict: 'uncertain', vc: 0.95 }), vf({ verification: null })], DEFAULT_RULES)
    expect(r.inline).toHaveLength(0)
    expect(r.dropped).toHaveLength(4)
    expect(r.verdict).toBe('ready_to_merge')
  })
  it('keeps an uncertain security finding the verifier is fairly sure about', () => {
    const r = rank([vf({ severity: 'security', verdict: 'uncertain', vc: 0.8 })], DEFAULT_RULES)
    expect(r.inline).toHaveLength(1)
    expect(r.verdict).toBe('needs_changes')
  })
  it('only blocks on the configured severities', () => {
    const r = rank([vf({ severity: 'test' })], { ...DEFAULT_RULES, blockOn: ['security'] })
    expect(r.verdict).toBe('ready_to_merge')
  })
})
