// The three things the pipeline talks to. Each has one adapter per product:
// Tracker (Jira, YouTrack, native), Forge (GitHub, GitLab), AgentRunner (Claude Code, Codex).
// Core logic depends on these only, so moving from GitHub to the office GitLab swaps adapters, not code.

import type { AgentReport } from './ledger.ts'
import type { RunLog } from './log.ts'

// Factory-level ticket states. Each tracker maps them to its own workflow statuses in .factory/config.yml.
export type TicketStatus = 'in_progress' | 'awaiting_approval' | 'blocked' | 'in_review' | 'done'

export type Ticket = {
  key: string
  title: string
  description: string
  url: string
}

export interface Tracker {
  get(key: string): Promise<Ticket>
  comment(key: string, markdown: string): Promise<void>
  transition(key: string, status: TicketStatus): Promise<void>
}

export type RepoRef = { owner: string; name: string; url: string }

export interface Forge {
  createRepo(input: { owner: string; name: string; isPrivate: boolean }): Promise<RepoRef>
  // A pull request on GitHub, a merge request on GitLab.
  openChange(input: { repo: RepoRef; branch: string; base: string; title: string; body: string }): Promise<{ url: string }>
  // Starts the next stage's CI job: repository_dispatch on GitHub, the pipeline trigger API on GitLab.
  dispatch(input: { repo: RepoRef; stage: string; ticket: string }): Promise<void>
}

export type McpServer = { command: string; args: string[]; env?: Record<string, string> }

export type AgentRequest = {
  brief: string
  cwd: string
  // read-only for planning and review, write for dev.
  access: 'read-only' | 'write'
  mcpServers: Record<string, McpServer>
  maxTurns: number
  maxBudgetUsd: number
  timeoutMs: number
  log: RunLog
}

export type Usage = {
  inputTokens: number // uncached input
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  costUsd: number | null // Claude reports an estimate; Codex reports tokens only
  turns: number | null
}

export type AgentResult = {
  report: AgentReport | null
  usage: Usage
  error: string | null
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>
}
