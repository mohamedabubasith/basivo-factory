// What a finder reports, what the verifier adds, and what one review run produces.
// Every line number is on the new side of the diff unless `side` says LEFT (a deleted line).

import { z } from 'zod'

export const SEVERITIES = ['security', 'bug', 'data', 'decision', 'test'] as const
export type Severity = (typeof SEVERITIES)[number]

// A finder's raw output. `evidence` must be a verbatim quote from the file at the head commit; pre-verify
// rejects findings whose quote is not in the file, which is how invented findings are dropped without a model.
export const Finding = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(['RIGHT', 'LEFT']).default('RIGHT'), // LEFT only for a problem on a deleted line
  severity: z.enum(SEVERITIES),
  claim: z.string().min(1).max(600),
  evidence: z.string().min(1).max(400),
  confidence: z.number().min(0).max(1),
})
export type Finding = z.infer<typeof Finding>

export const FinderReport = z.object({
  findings: z.array(Finding).max(20),
  notes: z.string().max(1000).default(''), // what was checked and found fine; goes to the summary
})
export type FinderReport = z.infer<typeof FinderReport>

// The verifier writes its reasoning before its verdict: the order is deliberate.
export const Verification = z.object({
  reasoning: z.string().min(1).max(1500),
  verdict: z.enum(['confirmed', 'rejected', 'uncertain']),
  confidence: z.number().min(0).max(1),
})
export type Verification = z.infer<typeof Verification>

export type VerifiedFinding = Finding & {
  agreement: number // how many finder passes reported it
  verification: Verification | null // null when pre-verify rejected it or the verifier failed
  rejectedBy: 'preverify' | null
  rejectReason: string | null
}

export type Verdict = 'ready_to_merge' | 'needs_changes'

export type ReviewResult = {
  forge: 'github' | 'gitlab'
  repo: string
  number: number
  headSha: string
  baseSha: string
  verdict: Verdict
  inline: VerifiedFinding[] // posted as line comments
  summaryOnly: VerifiedFinding[] // kept, but over the inline cap
  dropped: VerifiedFinding[] // rejected, for the log
  notes: string[]
  checked: string[] // deterministic checks that ran, for the summary
  ci: string | null
  usage: { costUsd: number; inputTokens: number; outputTokens: number; runs: number }
  skipped: string | null // set when the gate stopped the review
}
