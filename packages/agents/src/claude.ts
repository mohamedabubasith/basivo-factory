// Claude Code through the Claude Agent SDK. Every run is a fresh session: no saved transcript, no user or
// project settings, no skills, only the MCP servers we pass, and an environment holding one credential.
// Auth: CLAUDE_CODE_OAUTH_TOKEN (subscription), else ANTHROPIC_API_KEY, else the local `claude` login.

import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { preview, type AgentRequest, type AgentResult, type AgentRunner, type Usage } from '@basivo-factory/core'
import { agentEnv, basePrompt, classifyError, outputJsonSchema, parseOutput } from './common.ts'
import { claudeSkillPlugin } from './skills.ts'

const READ_TOOLS = ['Read', 'Grep', 'Glob']
const WRITE_TOOLS = ['Edit', 'Write', 'Bash']

const emptyUsage = (): Usage => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: null, turns: null })

// With both set, the CLI would bill the API key; the subscription token wins and the key is dropped.
const credential = (): Record<string, string | undefined> =>
  process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
    : { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }

function logMessage(req: AgentRequest<unknown>, m: SDKMessage) {
  if (m.type === 'assistant') {
    for (const block of m.message.content) {
      if (block.type === 'text') req.log.write('text', block.text)
      if (block.type === 'tool_use') req.log.write('tool', { name: block.name, input: block.input })
    }
  } else if (m.type === 'user' && Array.isArray(m.message.content)) {
    for (const block of m.message.content) {
      if (typeof block === 'object' && block.type === 'tool_result') {
        req.log.write('tool_result', { isError: block.is_error === true, content: preview(block.content) })
      }
    }
  }
}

// modelUsage covers every model call (main loop, subagents, compaction); `usage` is the main loop only.
function usageOf(m: SDKResultMessage): Usage {
  const totals = Object.values(m.modelUsage ?? {})
  const sum = (key: 'inputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'outputTokens') =>
    totals.reduce((n, u) => n + (u[key] ?? 0), 0)
  return {
    inputTokens: sum('inputTokens'),
    cacheReadTokens: sum('cacheReadInputTokens'),
    cacheWriteTokens: sum('cacheCreationInputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd: m.total_cost_usd,
    turns: m.num_turns,
  }
}

export function claudeRunner({ model }: { model?: string } = {}): AgentRunner {
  return {
    async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
      const plugin = claudeSkillPlugin(req.skills)
      // The Skill tool is what lets the agent open a skill's body; without it the skills are invisible.
      const tools = [...READ_TOOLS, ...(req.access === 'write' ? WRITE_TOOLS : []), ...(plugin ? ['Skill'] : [])]
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), req.timeoutMs)
      const stderr: string[] = []
      req.log.write('start', { runner: 'claude', role: req.role, model: model ?? 'default', access: req.access, briefChars: req.brief.length, instructionsChars: req.instructions.length, skills: req.skills.map(s => s.name), mcp: Object.keys(req.mcpServers) })
      let usage = emptyUsage()
      const fail = (error: string, errorClass = classifyError(error)): AgentResult<T> => {
        req.log.write('error', { error, errorClass })
        return { report: null, usage, error, errorClass }
      }
      try {
        for await (const m of query({
          prompt: req.brief,
          options: {
            cwd: req.cwd,
            model,
            systemPrompt: req.instructions ? [req.prompt ?? basePrompt(req.role), req.instructions] : (req.prompt ?? basePrompt(req.role)),
            tools,
            allowedTools: [...tools, ...Object.keys(req.mcpServers).map(name => `mcp__${name}`)],
            permissionMode: 'dontAsk',
            settingSources: [],
            skills: plugin?.names ?? [],
            plugins: plugin ? [{ type: 'local' as const, path: plugin.path, skipMcpDiscovery: true }] : [],
            strictMcpConfig: true,
            persistSession: false,
            mcpServers: Object.fromEntries(Object.entries(req.mcpServers).map(([n, s]) => [n, { type: 'stdio' as const, ...s }])),
            maxTurns: req.maxTurns,
            maxBudgetUsd: req.maxBudgetUsd,
            outputFormat: { type: 'json_schema', schema: outputJsonSchema(req.output) },
            abortController: abort,
            // Startup refusals (bad login, bad config) arrive as a result with a reason instead of a bare exit 1.
            env: agentEnv({ ...credential(), CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' }),
            stderr: data => void stderr.push(data),
          },
        })) {
          logMessage(req, m)
          if (m.type !== 'result') continue
          usage = usageOf(m)
          req.log.write('usage', usage)
          if (m.subtype !== 'success' || m.is_error) {
            const detail = ('errors' in m && m.errors?.length ? m.errors.join('; ') : '') || ('result' in m ? m.result : '') || m.subtype
            return fail(`${m.subtype}: ${detail}`, m.subtype === 'success' ? classifyError(detail) : 'agent')
          }
          const { report, error } = parseOutput(req.output, m.structured_output)
          req.log.write('result', report ?? error)
          return { report, usage, error, errorClass: error ? 'agent' : null }
        }
        return fail('run ended without a result')
      } catch (e) {
        if (abort.signal.aborted) return fail(`timed out after ${req.timeoutMs}ms`, 'timeout')
        return fail(`${String(e)}${stderr.length ? ` | stderr: ${stderr.join('').slice(-800)}` : ''}`)
      } finally {
        clearTimeout(timer)
        plugin?.done()
      }
    },
  }
}
