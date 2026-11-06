// Checks what an agent says against what actually happened. Two objective hallucination signals:
// files it claims to have changed that git shows untouched, and changes it made but did not report.

import { createHash } from 'node:crypto'
import type { AgentReport } from './ledger.ts'

// The same failure, whatever the line numbers, timings, temp paths and addresses that differ between runs.
// Two attempts in a row with one signature mean the agent is stuck.
export function failureSignature(output: string): string {
  const normalized = output
    .slice(-3000)
    .replace(/0x[0-9a-f]+/gi, 'H')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/(\/[\w.@-]+)+/g, 'P')
    .replace(/\s+/g, ' ')
    .trim()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export type ClaimCheck = {
  claimedButUnchanged: string[]
  changedButUnclaimed: string[]
  honest: boolean
}

export function checkClaims(report: AgentReport, actuallyChanged: string[]): ClaimCheck {
  const norm = (p: string) => p.replace(/^\.\//, '')
  const claimed = new Set(report.filesChanged.map(norm))
  const actual = new Set(actuallyChanged.map(norm))
  const claimedButUnchanged = [...claimed].filter(p => !actual.has(p)).sort()
  const changedButUnclaimed = [...actual].filter(p => !claimed.has(p)).sort()
  return { claimedButUnchanged, changedButUnclaimed, honest: claimedButUnchanged.length === 0 }
}
