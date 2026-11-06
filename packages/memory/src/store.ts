// The memory branch, checked out at `root`:
//   tickets/<KEY>/attempts.jsonl       one Attempt per line, written after each test stage
//   tickets/<KEY>/pending-facts.jsonl  facts an attempt saved, kept back until that attempt passes
//   repos/<owner>/<name>/facts.jsonl   one Fact per line: commands, conventions, pitfalls
// Attempts are per ticket. Facts are shared by every ticket on a repo, so the branch merges .jsonl files
// line by line (see sync.ts) and two jobs appending at once both keep their lines.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { Attempt, type AttemptInput } from '@basivo-factory/core'

export const Fact = z.object({
  repo: z.string(),
  topic: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  commit: z.string(),
  blobs: z.record(z.string(), z.string()),
  // Which ticket wrote it, so a reader can weigh where the fact came from.
  ticket: z.string().nullable().default(null),
  at: z.iso.datetime(),
})
export type Fact = z.infer<typeof Fact>
export type FactInput = z.input<typeof Fact>

// One line per agent run in tickets/<KEY>/usage.jsonl: the numbers behind the end-of-ticket report.
export const UsageRow = z.object({
  stage: z.string(),
  star: z.string(),
  runtime: z.string(),
  step: z.number().int().nullable(),
  attempt: z.number().int().nullable(),
  result: z.string(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
  turns: z.number().nullable(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  honest: z.boolean().nullable(), // did its claimed files match git? null when it made no claim
  at: z.iso.datetime(),
})
export type UsageRow = z.infer<typeof UsageRow>

// Keys become path segments, so anything that could climb out of the store is refused.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
function segments(value: string, label: string, count: number): string[] {
  const parts = value.split('/')
  if (parts.length !== count || !parts.every(p => SEGMENT.test(p) && p !== '..')) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}`)
  }
  return parts
}

// A bad line (a half-written append, a hand edit) is skipped and reported, so one line cannot switch off memory.
export function readJsonl<T>(file: string, schema: z.ZodType<T>, onBadLine: (where: string, why: string) => void): T[] {
  if (!existsSync(file)) return []
  const rows: T[] = []
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return onBadLine(`${file}:${i + 1}`, 'not JSON')
    }
    const parsed = schema.safeParse(value)
    if (parsed.success) rows.push(parsed.data)
    else onBadLine(`${file}:${i + 1}`, parsed.error.message)
  })
  return rows
}

function appendJsonl(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(value)}\n`)
}

export class MemoryStore {
  readonly root: string
  readonly badLines: string[] = []

  constructor(root: string) {
    this.root = root
  }

  private read<T>(file: string, schema: z.ZodType<T>): T[] {
    return readJsonl(file, schema, (where, why) => {
      this.badLines.push(where)
      console.error(`factory-memory: skipped ${where}: ${why}`)
    })
  }

  private ticketDir(ticket: string) {
    return join(this.root, 'tickets', ...segments(ticket, 'ticket key', 1))
  }

  private repoFile(repo: string) {
    return join(this.root, 'repos', ...segments(repo, 'repo (owner/name)', 2), 'facts.jsonl')
  }

  attempts(ticket: string): Attempt[] {
    return this.read(join(this.ticketDir(ticket), 'attempts.jsonl'), Attempt)
  }

  appendAttempt(attempt: AttemptInput): void {
    appendJsonl(join(this.ticketDir(attempt.ticket), 'attempts.jsonl'), Attempt.parse(attempt))
  }

  facts(repo: string): Fact[] {
    return this.read(this.repoFile(repo), Fact)
  }

  appendFact(fact: FactInput): void {
    appendJsonl(this.repoFile(fact.repo), Fact.parse(fact))
  }

  // Facts an attempt saves wait here; only an attempt whose tests pass gets to teach later runs.
  appendPendingFact(ticket: string, fact: FactInput): void {
    appendJsonl(join(this.ticketDir(ticket), 'pending-facts.jsonl'), Fact.parse(fact))
  }

  settlePendingFacts(ticket: string, keep: boolean): number {
    const file = join(this.ticketDir(ticket), 'pending-facts.jsonl')
    const pending = this.read(file, Fact)
    if (keep) for (const fact of pending) this.appendFact(fact)
    rmSync(file, { force: true })
    return keep ? pending.length : 0
  }

  appendUsage(ticket: string, row: UsageRow): void {
    appendJsonl(join(this.ticketDir(ticket), 'usage.jsonl'), UsageRow.parse(row))
  }

  usage(ticket: string): UsageRow[] {
    return this.read(join(this.ticketDir(ticket), 'usage.jsonl'), UsageRow)
  }

  // Whole-document state of a ticket (ticket.json, plan.json, review.json), passed from one CI job to the next.
  writeDoc(ticket: string, name: string, value: unknown): void {
    mkdirSync(this.ticketDir(ticket), { recursive: true })
    writeFileSync(join(this.ticketDir(ticket), `${segments(name, 'doc name', 1)[0]}.json`), `${JSON.stringify(value, null, 2)}\n`)
  }

  readDoc<T>(ticket: string, name: string, schema: z.ZodType<T>): T {
    const file = join(this.ticketDir(ticket), `${segments(name, 'doc name', 1)[0]}.json`)
    if (!existsSync(file)) throw new Error(`${ticket}: no ${name}.json in memory yet`)
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')))
  }

  tickets(): string[] {
    const dir = join(this.root, 'tickets')
    return existsSync(dir) ? readdirSync(dir).filter(name => SEGMENT.test(name)) : []
  }
}
