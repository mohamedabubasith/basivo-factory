// Deterministic checks between the finders and the verifier: a finding that points outside the diff, or whose
// quoted evidence is not in the file, is dropped here without a model. Then findings from different passes that
// point at the same spot are merged, and their agreement becomes a confidence boost.

import { createHash } from 'node:crypto'
import { evidenceExists, isTrivialEvidence, lineInDiff, locateEvidence, type HunkMap } from './hunks.ts'
import type { Finding, VerifiedFinding } from './schema.ts'

export type FileReader = (path: string) => string | null // file at the head commit, null when missing

const LINE_SLACK = 3

export function preverify(findings: Finding[], map: HunkMap, readFile: FileReader): { kept: VerifiedFinding[]; dropped: VerifiedFinding[] } {
  const kept: VerifiedFinding[] = []
  const dropped: VerifiedFinding[] = []
  const drop = (f: Finding, why: string) =>
    dropped.push({ ...f, agreement: 1, verification: null, rejectedBy: 'preverify', rejectReason: why })

  for (const f of findings) {
    if (!map.has(f.file)) {
      drop(f, 'file is not part of the change')
      continue
    }
    if (f.severity !== 'security' && isTrivialEvidence(f.evidence)) {
      drop(f, 'evidence is too short to prove anything')
      continue
    }
    const text = f.side === 'LEFT' ? null : readFile(f.file)
    let line = f.line
    if (f.side === 'RIGHT') {
      if (text === null) {
        drop(f, 'file is not readable at the head commit')
        continue
      }
      if (!evidenceExists(text, f.evidence)) {
        drop(f, 'quoted evidence is not in the file')
        continue
      }
      // A finder that quotes the right code but miscounts the line gets the line of its own quote.
      if (!lineInDiff(map, f.file, line, 'RIGHT')) {
        const at = locateEvidence(text, f.evidence)
        if (at !== null && lineInDiff(map, f.file, at, 'RIGHT')) line = at
      }
    }
    if (!lineInDiff(map, f.file, line, f.side)) {
      drop(f, `line ${f.line} is not in the diff`)
      continue
    }
    const same = kept.find(k => k.file === f.file && k.side === f.side && k.severity === f.severity && Math.abs(k.line - line) <= LINE_SLACK)
    if (same) {
      same.agreement += 1
      same.confidence = Math.min(1, Math.max(same.confidence, f.confidence) + 0.1)
      if (f.claim.length > same.claim.length) same.claim = f.claim
      continue
    }
    kept.push({ ...f, line, agreement: 1, verification: null, rejectedBy: null, rejectReason: null })
  }
  return { kept, dropped }
}

// Stable identity of a finding across runs on the same change: file + what it points at.
export const fingerprint = (f: Pick<Finding, 'file' | 'evidence' | 'severity'>): string =>
  createHash('sha256').update(`${f.file}\n${f.severity}\n${f.evidence.replace(/\s+/g, ' ').trim()}`).digest('hex').slice(0, 16)
