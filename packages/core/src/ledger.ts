import { z } from 'zod'

// What the agent must hand back at the end of every run (its structured output).
// It never reports whether tests passed: the test stage decides that by running them.
export const AgentReport = z.object({
  summary: z.string().min(1).max(2000),
  filesChanged: z.array(z.string()),
  notes: z.string().max(2000).nullable(),
})
export type AgentReport = z.infer<typeof AgentReport>

// What Polaris hands back. Each step must be checkable: `doneWhen` is a command that fails before the step is
// built and passes after it (the dev stage checks the "fails before" part itself).
export const Plan = z.object({
  summary: z.string().min(1).max(2000),
  steps: z
    .array(
      z.object({
        task: z.string().min(1).max(1500),
        doneWhen: z.string().min(1).max(500),
        protect: z.array(z.string()), // existing test files the step must not edit
        files: z.array(z.string()), // likely files, most relevant first
      }),
    )
    .min(1),
})
export type Plan = z.infer<typeof Plan>

// What Vega hands back after reading the change.
export const Review = z.object({
  verdict: z.enum(['approve', 'changes_requested']),
  summary: z.string().min(1).max(2000),
  findings: z.array(
    z.object({
      severity: z.enum(['bug', 'security', 'decision', 'test', 'clarity']),
      file: z.string(),
      line: z.number().int().nullable(),
      issue: z.string().min(1).max(1000),
    }),
  ),
})
export type Review = z.infer<typeof Review>

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
  // Normalised hash of the failure (numbers, times and paths stripped). The same signature twice in a row
  // means the agent is stuck, so the step blocks instead of spending another attempt.
  signature: z.string().nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  summary: z.string(),
  notes: z.string().nullable().default(null),
  filesChanged: z.array(z.string()).default([]),
  at: z.iso.datetime(),
})
export type Attempt = z.infer<typeof Attempt>
export type AttemptInput = z.input<typeof Attempt> // what a writer passes: defaulted fields may be left out
