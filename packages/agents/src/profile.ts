// A role's profile, read from the target repo, the way production agents are configured (Copilot's
// .github/agents/*.agent.md, Claude's .claude/agents, Factory's droids):
//   .factory/agents/<star>.md    frontmatter (runtime, model, mcp, skills, knowledge, limits) + the role's prompt
//   .factory/skills/<name>/       SKILL.md in the open Agent Skills format, shared by Claude and Codex
//   .factory/mcp.json             extra MCP servers by name; secrets as ${VAR}, filled from the CI environment
// A repo without .factory/ gets the defaults: the base prompt, no skills, no extra servers.

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { MAX_INSTRUCTIONS_CHARS, MAX_SKILLS, ProfileSettings, ROLES, SKILL_NAME, splitFrontmatter, type McpServer, type Role, type SkillRef } from '@basivo-factory/core'

export { MAX_INSTRUCTIONS_CHARS, MAX_SKILLS } from '@basivo-factory/core'
const Frontmatter = ProfileSettings

export type RoleProfile = z.infer<typeof Frontmatter> & {
  role: Role
  star: string
  instructions: string
  skillRefs: SkillRef[]
  mcpServers: Record<string, McpServer>
}

export function loadSkill(dir: string): SkillRef {
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) throw new Error(`skill ${dir}: no SKILL.md`)
  const { data } = splitFrontmatter(readFileSync(file, 'utf8'))
  const name = String(data.name ?? '')
  const description = String(data.description ?? '')
  if (!SKILL_NAME.test(name) || name.length > 64) throw new Error(`skill ${file}: name must be lowercase letters, digits and hyphens (max 64)`)
  if (name !== basename(dir)) throw new Error(`skill ${file}: name "${name}" must match its folder "${basename(dir)}"`)
  if (description.length < 1 || description.length > 1024) throw new Error(`skill ${file}: description must be 1 to 1024 characters`)
  return { name, description, dir }
}

// "${JIRA_TOKEN}" in mcp.json becomes the CI secret's value; a missing secret is an error, not an empty string.
function interpolate(value: string, where: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const v = process.env[name]
    if (v === undefined) throw new Error(`${where}: environment variable ${name} is not set`)
    return v
  })
}

const McpFile = z.object({
  servers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}) })),
})

function loadMcp(repoDir: string, names: string[], where: string): Record<string, McpServer> {
  if (names.length === 0) return {}
  const file = join(repoDir, '.factory', 'mcp.json')
  if (!existsSync(file)) throw new Error(`${where}: mcp ${names.join(', ')} requested but ${file} does not exist`)
  const { servers } = McpFile.parse(JSON.parse(readFileSync(file, 'utf8')))
  return Object.fromEntries(
    names.map(name => {
      const s = servers[name]
      if (!s) throw new Error(`${where}: mcp server "${name}" is not defined in .factory/mcp.json`)
      const at = `.factory/mcp.json servers.${name}`
      return [name, {
        command: interpolate(s.command, at),
        args: s.args.map(a => interpolate(a, at)),
        env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, interpolate(v, at)])),
      }]
    }),
  )
}

export function loadProfile(repoDir: string, role: Role): RoleProfile {
  const star = ROLES[role].star
  const file = join(repoDir, '.factory', 'agents', `${star.toLowerCase()}.md`)
  const { data, body } = existsSync(file) ? splitFrontmatter(readFileSync(file, 'utf8')) : { data: {}, body: '' }
  const where = existsSync(file) ? file : `${star} defaults`
  const parsed = Frontmatter.safeParse(data)
  if (!parsed.success) throw new Error(`${where}: ${parsed.error.message}`)
  const instructions = body.trim()
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    throw new Error(`${where}: role prompt is ${instructions.length} chars (max ${MAX_INSTRUCTIONS_CHARS}); move detail into a skill or the knowledge base`)
  }
  if (parsed.data.skills.length > MAX_SKILLS) throw new Error(`${where}: ${parsed.data.skills.length} skills (max ${MAX_SKILLS})`)
  if (parsed.data.mcp.includes('factory-memory')) throw new Error(`${where}: factory-memory is always on; do not list it`)
  return {
    ...parsed.data,
    role,
    star,
    instructions,
    skillRefs: parsed.data.skills.map(name => loadSkill(join(repoDir, '.factory', 'skills', name))),
    mcpServers: loadMcp(repoDir, parsed.data.mcp, where),
  }
}
