// Every agent run writes one JSONL event per step to its log file: what it called, what came back,
// what it said, what it cost. CI uploads the files, so any run can be replayed after the fact.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type LogKind = 'start' | 'text' | 'tool' | 'tool_result' | 'usage' | 'result' | 'error'

export type LogEvent = { at: string; run: string; agent: string; kind: LogKind; data: unknown }

export type RunLog = { write(kind: LogKind, data: unknown): void }

export function fileRunLog(file: string, run: string, agent: string): RunLog {
  mkdirSync(dirname(file), { recursive: true })
  return {
    write(kind, data) {
      const event: LogEvent = { at: new Date().toISOString(), run, agent, kind, data }
      appendFileSync(file, `${JSON.stringify(event)}\n`)
    },
  }
}

// For tests and dry runs.
export function memoryRunLog(): RunLog & { events: { kind: LogKind; data: unknown }[] } {
  const events: { kind: LogKind; data: unknown }[] = []
  return { events, write: (kind, data) => void events.push({ kind, data }) }
}

// Cuts long tool output so a log stays readable; the full content is in the repo or the tool itself.
export const preview = (value: unknown, max = 500): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text
}
