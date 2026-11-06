// The memory branch, checked out at `root`:
//   tickets/<KEY>/attempts.jsonl      one Attempt per line, written after each test stage
//   repos/<owner>/<name>/facts.jsonl  one Fact per line: commands, conventions, pitfalls
// One file per ticket and per repo, so parallel tickets append to different files and never conflict.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { Attempt } from '@basivo-factory/core'

export const Fact = z.object({
  repo: z.string(),
  topic: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  commit: z.string(),
  blobs: z.record(z.string(), z.string()),
  at: z.iso.datetime(),
})
export type Fact = z.infer<typeof Fact>

// Keys become path segments, so anything that could climb out of the store is refused.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
function segments(value: string, label: string, count: number): string[] {
  const parts = value.split('/')
  if (parts.length !== count || !parts.every(p => SEGMENT.test(p) && p !== '..')) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}`)
  }
  return parts
}

function readJsonl<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, i) => {
      const parsed = schema.safeParse(JSON.parse(line))
      if (!parsed.success) throw new Error(`${file}:${i + 1}: ${parsed.error.message}`)
      return parsed.data
    })
}

function appendJsonl(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(value)}\n`)
}

export class MemoryStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  private ticketFile(ticket: string) {
    return join(this.root, 'tickets', ...segments(ticket, 'ticket key', 1), 'attempts.jsonl')
  }

  private repoFile(repo: string) {
    return join(this.root, 'repos', ...segments(repo, 'repo (owner/name)', 2), 'facts.jsonl')
  }

  attempts(ticket: string): Attempt[] {
    return readJsonl(this.ticketFile(ticket), Attempt)
  }

  appendAttempt(attempt: Attempt): void {
    appendJsonl(this.ticketFile(attempt.ticket), Attempt.parse(attempt))
  }

  facts(repo: string): Fact[] {
    return readJsonl(this.repoFile(repo), Fact)
  }

  appendFact(fact: Fact): void {
    appendJsonl(this.repoFile(fact.repo), Fact.parse(fact))
  }

  tickets(): string[] {
    const dir = join(this.root, 'tickets')
    return existsSync(dir) ? readdirSync(dir).filter(name => SEGMENT.test(name)) : []
  }
}
