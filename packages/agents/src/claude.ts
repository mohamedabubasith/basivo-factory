// Claude Code through the Claude Agent SDK. Every run is a fresh session: no saved transcript, no user or
// project settings, only the MCP servers we pass. Auth: CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY.

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { preview, type AgentRequest, type AgentResult, type AgentRunner, type Usage } from '@basivo-factory/core'
import { parseReport, reportJsonSchema, SYSTEM_PROMPT } from './common.ts'

const READ_TOOLS = ['Read', 'Grep', 'Glob']
const WRITE_TOOLS = ['Edit', 'Write', 'Bash']

const emptyUsage = (): Usage => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: null, turns: null })

// Logs one SDK message; returns the final result message when it is one.
function logMessage(req: AgentRequest, m: SDKMessage) {
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

export function claudeRunner({ model }: { model?: string } = {}): AgentRunner {
  return {
    async run(req: AgentRequest): Promise<AgentResult> {
      const tools = req.access === 'write' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), req.timeoutMs)
      req.log.write('start', { runner: 'claude', model: model ?? 'default', access: req.access, briefChars: req.brief.length })
      const usage = emptyUsage()
      try {
        for await (const m of query({
          prompt: req.brief,
          options: {
            cwd: req.cwd,
            model,
            systemPrompt: SYSTEM_PROMPT,
            tools,
            allowedTools: [...tools, ...Object.keys(req.mcpServers).map(name => `mcp__${name}`)],
            permissionMode: 'dontAsk',
            settingSources: [],
            strictMcpConfig: true,
            persistSession: false,
            mcpServers: Object.fromEntries(Object.entries(req.mcpServers).map(([n, s]) => [n, { type: 'stdio' as const, ...s }])),
            maxTurns: req.maxTurns,
            maxBudgetUsd: req.maxBudgetUsd,
            outputFormat: { type: 'json_schema', schema: reportJsonSchema() },
            abortController: abort,
            env: { ...process.env },
          },
        })) {
          logMessage(req, m)
          if (m.type !== 'result') continue
          Object.assign(usage, {
            inputTokens: m.usage.input_tokens,
            cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: m.usage.cache_creation_input_tokens ?? 0,
            outputTokens: m.usage.output_tokens,
            costUsd: m.total_cost_usd,
            turns: m.num_turns,
          })
          req.log.write('usage', usage)
          if (m.subtype !== 'success') {
            req.log.write('error', m.subtype)
            return { report: null, usage, error: m.subtype }
          }
          const { report, error } = parseReport(m.structured_output)
          req.log.write('result', report ?? error)
          return { report, usage, error }
        }
        return { report: null, usage, error: 'run ended without a result' }
      } catch (e) {
        const error = abort.signal.aborted ? `timed out after ${req.timeoutMs}ms` : String(e)
        req.log.write('error', error)
        return { report: null, usage, error }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
