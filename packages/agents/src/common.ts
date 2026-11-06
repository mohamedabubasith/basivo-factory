import { z } from 'zod'
import { AgentReport } from '@basivo-factory/core'

// Kept short on purpose: this plus the brief is all the context an agent starts with.
export const SYSTEM_PROMPT = `You are a coding agent in an automated pipeline. Work only on the step in the brief.
Find what you need with search tools and the factory-memory tools (ledger, facts, similar); never read the whole repository.
On attempt 2 or later, call ledger first and do not repeat an approach that already failed.
Memory entries marked stale describe files that changed since; verify them before relying on them.
Save durable lessons about this repository with record_fact.
Never claim that tests pass: the pipeline runs them after you.
Finish with the structured report: a short summary, filesChanged listing exactly the paths you changed (empty if none), and notes.`

// Strict JSON Schema for the final report. Codex requires every property listed and no extras; Claude Code's
// validator rejects zod's `$schema: draft 2020-12` key, so it is dropped.
export const reportJsonSchema = (): Record<string, unknown> => {
  const { $schema: _, ...schema } = z.toJSONSchema(AgentReport) as Record<string, unknown>
  return { ...schema, additionalProperties: false }
}

export function parseReport(value: unknown): { report: AgentReport | null; error: string | null } {
  const parsed = AgentReport.safeParse(typeof value === 'string' ? safeJson(value) : value)
  return parsed.success ? { report: parsed.data, error: null } : { report: null, error: `invalid report: ${parsed.error.message}` }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
