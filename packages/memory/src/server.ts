// The factory-memory MCP server. Agents pull memory through it instead of receiving it in the prompt.
// Every entry it returns says whether the files it describes have changed since it was written.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { blobShas, changedPaths, DELETED, headCommit } from './git.ts'
import { buildIndex, type Doc } from './search.ts'
import { loadKnowledge, readKnowledge, searchKnowledge } from './knowledge.ts'
import type { Fact, MemoryStore } from './store.ts'

export type MemoryServerOptions = {
  store: MemoryStore
  repoDir: string // the target repo's working tree, for staleness and new facts
  repo: string // owner/name, whose facts this job reads and writes
  ticket: string // the ticket this run works on; facts it saves wait until its attempt passes
  knowledge?: string[] // globs of docs the kb tools may search; none means no kb tools
  now?: () => Date
}

type Entry = { blobs: Record<string, string> }

// Marks each entry stale or fresh with one `git ls-tree` for all the paths involved.
function withStaleness<T extends Entry>(repoDir: string, entries: T[]) {
  const paths = [...new Set(entries.flatMap(e => Object.keys(e.blobs)))]
  const current = blobShas(repoDir, paths)
  return entries.map(({ blobs, ...rest }) => {
    const changed = changedPaths(blobs, current)
    return { ...rest, paths: Object.keys(blobs), stale: changed.length > 0, changedPaths: changed }
  })
}

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

export function createMemoryServer({ store, repoDir, repo, ticket, knowledge = [], now = () => new Date() }: MemoryServerOptions): McpServer {
  const server = new McpServer({ name: 'factory-memory', version: '0.1.0' })

  server.registerTool(
    'ledger',
    {
      description:
        'Every attempt so far on a ticket: what was tried, the test result and why it failed. Read it before changing code on a retry, so you do not repeat a failed approach. Entries marked stale describe files that have changed since.',
      inputSchema: { ticket: z.string().describe('Ticket key, e.g. PROJ-12') },
    },
    async ({ ticket }) => reply(withStaleness(repoDir, store.attempts(ticket))),
  )

  server.registerTool(
    'facts',
    {
      description:
        "This repository's saved facts: build and test commands, conventions, pitfalls. Give a topic to get only the relevant ones. Stale facts describe files that changed since; check them before relying on them.",
      inputSchema: { topic: z.string().optional().describe('What you need, e.g. "run tests" or "auth"') },
    },
    async ({ topic }) => {
      const facts = store.facts(repo)
      if (!topic) return reply(withStaleness(repoDir, facts))
      const hits = buildIndex(facts.map((f, i) => ({ id: String(i), text: `${f.topic} ${f.body}` }))).search(topic, 10)
      return reply(withStaleness(repoDir, hits.map(h => facts[Number(h.id)]!)))
    },
  )

  server.registerTool(
    'similar',
    {
      description:
        'Past attempts on any ticket, and facts, that match a description or an error message. Use it when a test fails to see whether the same failure was fixed before.',
      inputSchema: {
        text: z.string().min(2).describe('An error message, a failure reason or a short description'),
        limit: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ text, limit = 5 }) => {
      const docs: Doc[] = []
      const entries = new Map<string, Entry & Record<string, unknown>>()
      for (const ticket of store.tickets()) {
        for (const a of store.attempts(ticket)) {
          const id = `attempt:${a.ticket}:${a.step}:${a.attempt}`
          entries.set(id, { kind: 'attempt', ...a })
          docs.push({ id, text: `${a.summary} ${a.failureReason ?? ''} ${Object.keys(a.blobs).join(' ')}` })
        }
      }
      store.facts(repo).forEach((f, i) => {
        entries.set(`fact:${i}`, { kind: 'fact', ...f })
        docs.push({ id: `fact:${i}`, text: `${f.topic} ${f.body}` })
      })
      const hits = buildIndex(docs).search(text, limit)
      return reply(withStaleness(repoDir, hits.map(h => entries.get(h.id)!)))
    },
  )

  server.registerTool(
    'record_fact',
    {
      description:
        'Save something later runs should know about this repository: a command, a convention, a pitfall. Name the files it is about, so it is marked stale once they change. Keep it to one or two sentences. It is kept only if this attempt passes its tests.',
      inputSchema: {
        topic: z.string().min(1).max(200),
        body: z.string().min(1).max(2000),
        paths: z.array(z.string()).describe('Repository files this fact is about'),
      },
    },
    async ({ topic, body, paths }) => {
      const blobs = blobShas(repoDir, paths)
      const missing = paths.filter(p => blobs[p] === DELETED)
      if (missing.length) return { ...reply({ error: `not tracked at HEAD: ${missing.join(', ')}` }), isError: true }
      const fact: Fact = { repo, topic, body, commit: headCommit(repoDir), blobs, ticket, at: now().toISOString() }
      store.appendPendingFact(ticket, fact)
      return reply({ saved: true, keptOnlyIf: 'this attempt passes its tests' })
    },
  )

  if (knowledge.length) {
    const docs = loadKnowledge(repoDir, knowledge)
    server.registerTool(
      'kb_search',
      {
        description:
          "Search this project's knowledge base (docs, ADRs, runbooks) for decisions, conventions and how-tos. Returns paths, titles and summaries; read a doc with kb_read. Stale docs were not reviewed recently or their code changed since; verify them against the code.",
        inputSchema: { query: z.string().min(2), limit: z.number().int().min(1).max(10).optional() },
      },
      async ({ query, limit = 5 }) => reply(searchKnowledge(repoDir, docs, query, limit, now())),
    )
    server.registerTool(
      'kb_read',
      {
        description: 'Read part of a knowledge-base doc found with kb_search, by line range. Read only what you need.',
        inputSchema: {
          path: z.string(),
          fromLine: z.number().int().min(1).optional(),
          lines: z.number().int().min(1).max(400).optional(),
        },
      },
      async ({ path, fromLine = 1, lines = 120 }) => {
        const doc = docs.find(d => d.path === path)
        if (!doc) return { ...reply({ error: `not in the knowledge base: ${path}` }), isError: true }
        return reply(readKnowledge(doc, fromLine, lines))
      },
    )
  }

  return server
}
