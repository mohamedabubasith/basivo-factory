// Turns run logs and usage rows into the numbers a person checks: tokens, cost, tool errors, honesty.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { AgentResult, LogEvent, Usage } from '@basivo-factory/core'
import type { UsageRow } from '@basivo-factory/memory'

export function logStats(logFile: string): { toolCalls: number; toolErrors: number } {
  if (!existsSync(logFile)) return { toolCalls: 0, toolErrors: 0 }
  const events = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as LogEvent)
  return {
    toolCalls: events.filter(e => e.kind === 'tool').length,
    toolErrors: events.filter(e => e.kind === 'tool_result' && (e.data as { isError?: boolean }).isError).length,
  }
}

const zeroUsage: Usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: null, turns: null }

export function usageRow(fields: {
  stage: string; star: string; runtime: string; step?: number | null; attempt?: number | null
  result: string; agent: AgentResult<unknown> | null; logFile: string; honest?: boolean | null
}): UsageRow {
  const u = fields.agent?.usage ?? zeroUsage
  return {
    stage: fields.stage, star: fields.star, runtime: fields.runtime, step: fields.step ?? null, attempt: fields.attempt ?? null,
    result: fields.result, ...u, ...logStats(fields.logFile), honest: fields.honest ?? null, at: new Date().toISOString(),
  }
}

const n = (v: number) => v.toLocaleString('en-US')

export function usageTable(rows: UsageRow[]): string {
  const head = '| Agent | Step | Attempt | Result | Input (uncached / cache read / cache write) | Output | Cost | Turns | Tools (errors) | Honest |\n|---|---|---|---|---|---|---|---|---|---|'
  const body = rows.map(r =>
    `| ${r.star} (${r.runtime}) | ${r.step ?? '–'} | ${r.attempt ?? '–'} | ${r.result} | ${n(r.inputTokens)} / ${n(r.cacheReadTokens)} / ${n(r.cacheWriteTokens)} | ${n(r.outputTokens)} | ${r.costUsd === null ? '–' : `$${r.costUsd.toFixed(3)}`} | ${r.turns ?? '–'} | ${r.toolCalls} (${r.toolErrors}) | ${r.honest === null ? '–' : r.honest ? 'yes' : '**no**'} |`)
  const sum = (k: 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens') => rows.reduce((t, r) => t + r[k], 0)
  const cost = rows.reduce((t, r) => t + (r.costUsd ?? 0), 0)
  const total = `| **Total** | | ${rows.length} runs | | ${n(sum('inputTokens'))} / ${n(sum('cacheReadTokens'))} / ${n(sum('cacheWriteTokens'))} | ${n(sum('outputTokens'))} | $${cost.toFixed(3)} | | ${rows.reduce((t, r) => t + r.toolCalls, 0)} (${rows.reduce((t, r) => t + r.toolErrors, 0)}) | ${rows.filter(r => r.honest === false).length} dishonest |`
  return [head, ...body, total].join('\n')
}

// Live progress for the dashboard. Only when the workflow passes FACTORY_DASHBOARD_URL and FACTORY_INGEST_TOKEN;
// a slow or broken dashboard never slows or fails a run (5 s limit, errors ignored).
export async function emit(ticket: string, kind: string, data: Record<string, unknown> = {}): Promise<void> {
  const { FACTORY_DASHBOARD_URL: url, FACTORY_INGEST_TOKEN: token, GITHUB_RUN_ID: runId } = process.env
  if (!url || !token || !runId) return
  try {
    await fetch(`${url.replace(/\/+$/, '')}/api/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, run: process.env.FACTORY_RUN ?? 'all', ghRunId: Number(runId), kind, data, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // progress is best effort
  }
}

// The Actions run page shows this under each job.
export function jobSummary(markdown: string): void {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`)
  else console.log(markdown)
}
