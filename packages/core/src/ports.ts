// The three things the pipeline talks to. Each has one adapter per product:
// Tracker (Jira, YouTrack, native), Forge (GitHub, GitLab), AgentRunner (Claude Code, Codex).
// Core logic depends on these only, so moving from GitHub to the office GitLab swaps adapters, not code.

import type { z } from 'zod'
import type { AgentReport } from './ledger.ts'
import type { Role } from './roles.ts'
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

// A skill in the open Agent Skills format: a folder holding SKILL.md (name + description frontmatter, body),
// plus optional scripts/ and references/. Only name and description reach the prompt; the agent loads the rest.
export type SkillRef = { name: string; description: string; dir: string }

// T is what the agent must hand back: the dev report by default, a plan for Polaris, a review for Vega.
export type AgentRequest<T = AgentReport> = {
  role: Role // picks the base prompt; the profile's instructions are added after it
  output: z.ZodType<T>
  brief: string
  cwd: string
  instructions: string // the role's own prompt from .factory/agents/<star>.md, added after the base prompt
  skills: SkillRef[] // only these skills are visible to the agent
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

// Why a run produced no usable report. Only 'agent' failures (and failing tests) cost an attempt: a rate
// limit, an exhausted plan, a bad login or a CLI that would not start is retried later at the same attempt.
export type ErrorClass = 'agent' | 'timeout' | 'rate_limited' | 'quota' | 'auth' | 'startup'
export const COUNTS_AS_ATTEMPT: ReadonlySet<ErrorClass> = new Set(['agent', 'timeout'])

export type AgentResult<T = AgentReport> = {
  report: T | null
  usage: Usage
  error: string | null
  errorClass: ErrorClass | null
}

export interface AgentRunner {
  run<T>(request: AgentRequest<T>): Promise<AgentResult<T>>
}
