// Checks what an agent says against what actually happened. Two objective hallucination signals:
// files it claims to have changed that git shows untouched, and changes it made but did not report.

import type { AgentReport } from './ledger.ts'

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
