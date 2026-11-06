#!/usr/bin/env node
// stdio entry point that Claude Code and Codex start as an MCP server.
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMemoryServer } from './server.ts'
import { MemoryStore } from './store.ts'

const { values } = parseArgs({
  options: { root: { type: 'string' }, 'repo-dir': { type: 'string' }, repo: { type: 'string' }, ticket: { type: 'string' }, knowledge: { type: 'string', multiple: true } },
})
if (!values.root || !values['repo-dir'] || !values.repo || !values.ticket) {
  console.error('usage: factory-memory --root <memory branch dir> --repo-dir <repo dir> --repo <owner/name> --ticket <KEY>')
  process.exit(1)
}

const server = createMemoryServer({ store: new MemoryStore(values.root), repoDir: values['repo-dir'], repo: values.repo, ticket: values.ticket, knowledge: values.knowledge ?? [] })
await server.connect(new StdioServerTransport())
