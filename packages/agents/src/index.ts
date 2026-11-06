import type { AgentRunner } from '@basivo-factory/core'
import { claudeRunner } from './claude.ts'
import { codexRunner } from './codex.ts'

export { claudeRunner, codexRunner }
export { loadProfile, loadSkill, MAX_INSTRUCTIONS_CHARS, MAX_SKILLS, type RoleProfile } from './profile.ts'
export { claudeSkillPlugin, codexSkillConfig, PLUGIN_NAME } from './skills.ts'
export { SYSTEM_PROMPT, agentEnv, classifyError, parseReport, reportJsonSchema } from './common.ts'

export function runnerFor(name: 'claude' | 'codex', model?: string): AgentRunner {
  return name === 'claude' ? claudeRunner({ model }) : codexRunner({ model })
}
