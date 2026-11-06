// Puts exactly a role's skills in front of each runtime. Both expect skills in their own folders, so the
// chosen skill folders are symlinked into a throwaway directory per run; the originals are never touched.

import { existsSync, globSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SkillRef } from '@basivo-factory/core'
import type { CodexOptions } from '@openai/codex-sdk'

type CodexConfig = NonNullable<CodexOptions['config']>

export const PLUGIN_NAME = 'factory'

// Claude: a local plugin holding the skills, loaded alongside settingSources: [] (which loads none of the
// user's or project's). The run then filters to `factory:<name>`, so Claude Code's own bundled skills stay out.
export function claudeSkillPlugin(skills: SkillRef[]): { path: string; names: string[]; done(): void } | null {
  if (skills.length === 0) return null
  const root = mkdtempSync(join(tmpdir(), 'factory-claude-skills-'))
  mkdirSync(join(root, '.claude-plugin'))
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN_NAME, version: '0.0.0' }))
  mkdirSync(join(root, 'skills'))
  for (const s of skills) symlinkSync(resolve(s.dir), join(root, 'skills', s.name))
  return { path: root, names: skills.map(s => `${PLUGIN_NAME}:${s.name}`), done: () => rmSync(root, { recursive: true, force: true }) }
}

// Codex scans $CODEX_HOME/skills (our per-run folder), but also ~/.agents/skills, /etc/codex/skills and every
// .agents/skills from the repo up, and ships bundled skills. Ours are linked into $CODEX_HOME/skills; every
// other SKILL.md it would find is switched off by path, and the bundled ones are disabled.
export function codexSkillConfig(skills: SkillRef[], codexHome: string, cwd: string): CodexConfig {
  if (skills.length === 0) return { include_instructions: false }
  const dir = join(codexHome, 'skills')
  mkdirSync(dir, { recursive: true })
  for (const s of skills) symlinkSync(resolve(s.dir), join(dir, s.name))
  const chosen = new Set(skills.map(s => resolve(s.dir, 'SKILL.md')))
  const roots = [join(process.env.HOME ?? homedir(), '.agents', 'skills'), '/etc/codex/skills']
  for (let d = resolve(cwd); ; d = dirname(d)) {
    roots.push(join(d, '.agents', 'skills'))
    if (dirname(d) === d) break
  }
  const others = roots
    .filter(existsSync)
    .flatMap(root => globSync('*/SKILL.md', { cwd: root }).map(f => resolve(root, f)))
    .filter(f => !chosen.has(f))
  return { include_instructions: true, bundled: { enabled: false }, config: others.map(path => ({ path, enabled: false })) }
}
