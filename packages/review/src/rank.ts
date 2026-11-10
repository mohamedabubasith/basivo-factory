// After the verifier: what to post inline, what goes to the summary, and the verdict. Plain rules, so a person
// can predict them from .factory/review.md.

import { SEVERITIES, type Severity, type Verdict, type VerifiedFinding } from './schema.ts'

export type RankRules = {
  maxComments: number
  blockOn: Severity[]
  minConfidence: number // for 'uncertain' security/bug findings
}

export const DEFAULT_RULES: RankRules = { maxComments: 5, blockOn: ['security', 'bug', 'data'], minConfidence: 0.75 }

const order = (s: Severity) => SEVERITIES.indexOf(s)

export function rank(findings: VerifiedFinding[], rules: RankRules): { inline: VerifiedFinding[]; summaryOnly: VerifiedFinding[]; dropped: VerifiedFinding[]; verdict: Verdict } {
  const kept: VerifiedFinding[] = []
  const dropped: VerifiedFinding[] = []
  for (const f of findings) {
    const v = f.verification
    if (!v) {
      dropped.push({ ...f, rejectReason: f.rejectReason ?? 'verifier did not run' })
      continue
    }
    if (v.verdict === 'confirmed') kept.push(f)
    else if (v.verdict === 'uncertain' && (f.severity === 'security' || f.severity === 'bug') && v.confidence >= rules.minConfidence) kept.push(f)
    else dropped.push({ ...f, rejectReason: `verifier: ${v.verdict} (${v.reasoning.slice(0, 200)})` })
  }
  kept.sort((a, b) => order(a.severity) - order(b.severity) || (b.verification!.confidence - a.verification!.confidence) || b.agreement - a.agreement)
  const verdict: Verdict = kept.some(f => rules.blockOn.includes(f.severity)) ? 'needs_changes' : 'ready_to_merge'
  return { inline: kept.slice(0, rules.maxComments), summaryOnly: kept.slice(rules.maxComments), dropped, verdict }
}
