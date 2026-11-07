// The settings an agent profile (.factory/agents/<star>.md) may hold. Shared by the CLI, which reads profiles
// from the repo, and the dashboard, which edits them in forms.

import { z } from 'zod'
import { splitFrontmatter } from './frontmatter.ts'

// Pushed into every run of the role, so kept small; longer material belongs in a skill or the knowledge base.
export const MAX_INSTRUCTIONS_CHARS = 6000
export const MAX_SKILLS = 8

// The Agent Skills spec: lowercase name of letters, digits and hyphens, matching the folder.
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const ProfileSettings = z.object({
  runtime: z.enum(['claude', 'codex']).default('claude'),
  model: z.string().optional(),
  mcp: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]), // at most MAX_SKILLS; checked by the readers so the error names the file
  knowledge: z.array(z.string()).default([]), // globs, relative to the repo, the knowledge tools may search
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
})
export type ProfileSettings = z.infer<typeof ProfileSettings>

export type ProfileDoc = { settings: ProfileSettings; instructions: string }

export function parseProfileDoc(text: string): ProfileDoc {
  const { data, body } = splitFrontmatter(text)
  return { settings: ProfileSettings.parse(data), instructions: body.trim() }
}

// Writes only the settings that are set, in a fixed order, so a dashboard save gives a small, readable diff.
export function formatProfileDoc({ settings, instructions }: ProfileDoc): string {
  const s = ProfileSettings.parse(settings)
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) throw new Error(`instructions are longer than ${MAX_INSTRUCTIONS_CHARS} characters`)
  if (s.skills.length > MAX_SKILLS) throw new Error(`${s.skills.length} skills (max ${MAX_SKILLS})`)
  const ordered: Record<string, unknown> = { runtime: s.runtime }
  if (s.model) ordered.model = s.model
  if (s.mcp.length) ordered.mcp = s.mcp
  if (s.skills.length) ordered.skills = s.skills
  if (s.knowledge.length) ordered.knowledge = s.knowledge
  if (s.maxTurns !== undefined) ordered.maxTurns = s.maxTurns
  if (s.maxBudgetUsd !== undefined) ordered.maxBudgetUsd = s.maxBudgetUsd
  const lines = Object.entries(ordered).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map(scalar).join(', ')}]` : scalar(v)}`)
  return `---\n${lines.join('\n')}\n---\n${instructions.trim()}\n`
}

// Plain words stay bare (claude, write-failing-test); anything YAML could misread is quoted.
const scalar = (v: unknown): string =>
  typeof v === 'number' ? String(v) : /^[a-z][\w.-]*$/i.test(String(v)) ? String(v) : JSON.stringify(String(v))
