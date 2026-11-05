import { z } from 'zod'

// What the agent must hand back at the end of every run (its structured output).
// It never reports whether tests passed: the test stage decides that by running them.
export const AgentReport = z.object({
  summary: z.string().min(1).max(2000),
  filesChanged: z.array(z.string()),
  notes: z.string().max(2000).nullable(),
})
export type AgentReport = z.infer<typeof AgentReport>

// One line of tickets/<KEY>/attempts.jsonl on the memory branch, written by code after the test stage.
export const Attempt = z.object({
  ticket: z.string(),
  step: z.number().int().min(1),
  attempt: z.number().int().min(1),
  commit: z.string(),
  // Git blob SHA per touched path at `commit`, so a later read can tell the entry has gone stale.
  blobs: z.record(z.string(), z.string()),
  testCommand: z.string(),
  result: z.enum(['pass', 'fail']),
  failureReason: z.string().nullable(),
  summary: z.string(),
  at: z.iso.datetime(),
})
export type Attempt = z.infer<typeof Attempt>
