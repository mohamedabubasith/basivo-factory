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

// The Actions run page shows this under each job.
export function jobSummary(markdown: string): void {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`)
  else console.log(markdown)
}
