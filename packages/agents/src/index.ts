import type { AgentRunner } from '@basivo-factory/core'
import { claudeRunner } from './claude.ts'
import { codexRunner } from './codex.ts'

export { claudeRunner, codexRunner }
export { SYSTEM_PROMPT, parseReport, reportJsonSchema } from './common.ts'

export function runnerFor(name: 'claude' | 'codex', model?: string): AgentRunner {
  return name === 'claude' ? claudeRunner({ model }) : codexRunner({ model })
}
