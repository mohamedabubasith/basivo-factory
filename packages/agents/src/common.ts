import { z } from 'zod'
import { AgentReport, type ErrorClass } from '@basivo-factory/core'

// Kept short on purpose: this plus the brief is all the context an agent starts with.
export const SYSTEM_PROMPT = `You are a coding agent in an automated pipeline. Work only on the step in the brief.
Find what you need with search tools and the factory-memory tools (ledger, facts, similar); never read the whole repository.
On attempt 2 or later, call ledger first and do not repeat an approach that already failed.
Memory entries marked stale describe files that changed since; verify them before relying on them.
Never edit the test files the brief names: the step is graded by them.
Do not run git commit, reset, stash, checkout or any branch command; the pipeline commits your changes.
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

// What the agent process may see: what a shell and the toolchain need, plus the one credential for this
// runner. Everything else in the job's environment (other tokens, cloud keys, CI secrets) stays out of reach
// of the agent's shell commands.
const PASS_THROUGH = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TERM|TMPDIR|TMP|TEMP|TZ|CI|NODE_OPTIONS|XDG_\w+)$/

export function agentEnv(extra: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && PASS_THROUGH.test(k)) env[k] = v
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v
  return env
}

// Sorts a failure by whether retrying the same attempt later can help.
export function classifyError(message: string): ErrorClass {
  const m = message.toLowerCase()
  if (/timed out/.test(m)) return 'timeout'
  if (/\b429\b|rate.?limit|overloaded|too many requests/.test(m)) return 'rate_limited'
  if (/usage limit|quota|insufficient_quota|credit balance|billing|plan limit/.test(m)) return 'quota'
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid api key|not logged in|login|refresh_token|oauth|authenticat/.test(m)) return 'auth'
  if (/not supported when using|model .*not (found|available|supported)|spawn|enoent|exited with code|failed to start/.test(m)) return 'startup'
  return 'agent'
}
