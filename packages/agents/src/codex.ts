// OpenAI Codex through @openai/codex-sdk. A new thread per run; the MCP servers are passed as config.
// Auth: CODEX_API_KEY / OPENAI_API_KEY (API billing), else auth.json from a ChatGPT login (subscription).
// Codex has no turn or budget cap, so the wall-clock timeout is the cap, and it reports tokens, not USD.

import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Codex, type ThreadEvent } from '@openai/codex-sdk'
import { preview, type AgentRequest, type AgentResult, type AgentRunner, type Usage } from '@basivo-factory/core'
import { agentEnv, basePrompt, classifyError, outputJsonSchema, parseOutput } from './common.ts'
import { codexSkillConfig } from './skills.ts'

// Each run gets an empty CODEX_HOME, so the user's config.toml, AGENTS.md and memories never reach the agent.
// The login is symlinked, not copied: Codex refresh tokens are single-use, so a copy would go stale the moment
// any run refreshed it (refresh_token_reused), and a crash before copying back would lose the new token.
function isolatedHome(apiKey: string | undefined): { home: string; done(): void } {
  const realAuth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
  if (!apiKey && !existsSync(realAuth)) {
    throw new Error(`codex auth: no CODEX_API_KEY/OPENAI_API_KEY and no ${realAuth}; run \`codex login\``)
  }
  const home = mkdtempSync(join(tmpdir(), 'factory-codex-'))
  if (!apiKey) symlinkSync(realAuth, join(home, 'auth.json'))
  return { home, done: () => rmSync(home, { recursive: true, force: true }) }
}

function logEvent(req: AgentRequest<unknown>, ev: ThreadEvent) {
  if (ev.type !== 'item.completed') return
  const item = ev.item
  switch (item.type) {
    case 'agent_message':
      return req.log.write('text', item.text)
    case 'command_execution':
      req.log.write('tool', { name: 'shell', input: item.command })
      return req.log.write('tool_result', { isError: (item.exit_code ?? 0) !== 0, content: preview(item.aggregated_output) })
    case 'mcp_tool_call':
      req.log.write('tool', { name: `mcp__${item.server}__${item.tool}`, input: item.arguments })
      return req.log.write('tool_result', {
        isError: item.status === 'failed',
        content: item.error ? `error: ${item.error.message}` : preview(item.result?.content),
      })
    case 'file_change':
      return req.log.write('tool', { name: 'apply_patch', input: item.changes })
    case 'error':
      return req.log.write('error', item.message)
  }
}

export function codexRunner({ model }: { model?: string } = {}): AgentRunner {
  return {
    async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
      const usage: Usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: null, turns: null }
      const fail = (error: string, errorClass = classifyError(error)): AgentResult<T> => {
        req.log.write('error', { error, errorClass })
        return { report: null, usage, error, errorClass }
      }
      const apiKey = process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY
      let isolation: ReturnType<typeof isolatedHome>
      try {
        isolation = isolatedHome(apiKey)
      } catch (e) {
        return fail(String(e), 'auth')
      }
      const codex = new Codex({
        apiKey,
        env: agentEnv({ CODEX_HOME: isolation.home }),
        config: {
          // Only the role's skills: everything else Codex would discover is switched off (see skills.ts).
          skills: codexSkillConfig(req.skills, isolation.home, req.cwd),
          ...(req.instructions ? { developer_instructions: req.instructions } : {}),
          mcp_servers: Object.fromEntries(
            Object.entries(req.mcpServers).map(([n, s]) => [
              n,
              // Our own servers are trusted; with approval policy "never", unapproved tools would be refused.
              { command: s.command, args: s.args, env: s.env ?? {}, default_tools_approval_mode: 'approve' },
            ]),
          ),
        },
      })
      const thread = codex.startThread({
        model,
        workingDirectory: req.cwd,
        sandboxMode: req.access === 'write' ? 'workspace-write' : 'read-only',
        approvalPolicy: 'never',
        // Same reach as the Claude runner: the agent may install packages its tests need.
        networkAccessEnabled: true,
      })
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), req.timeoutMs)
      req.log.write('start', { runner: 'codex', role: req.role, model: model ?? 'default', access: req.access, briefChars: req.brief.length, instructionsChars: req.instructions.length, skills: req.skills.map(s => s.name), mcp: Object.keys(req.mcpServers) })
      let final = ''
      try {
        const { events } = await thread.runStreamed(`${basePrompt(req.role)}\n\n${req.brief}`, { outputSchema: outputJsonSchema(req.output), signal: abort.signal })
        for await (const ev of events) {
          logEvent(req, ev)
          if (ev.type === 'item.completed' && ev.item.type === 'agent_message') final = ev.item.text
          if (ev.type === 'turn.completed' && ev.usage) {
            // Codex counts cached tokens inside input_tokens; split them out to match Claude's shape.
            Object.assign(usage, {
              inputTokens: ev.usage.input_tokens - ev.usage.cached_input_tokens,
              cacheReadTokens: ev.usage.cached_input_tokens,
              cacheWriteTokens: ev.usage.cache_write_input_tokens,
              outputTokens: ev.usage.output_tokens,
            })
            req.log.write('usage', usage)
          }
          if (ev.type === 'turn.failed') return fail(ev.error.message)
          if (ev.type === 'error') return fail(ev.message)
        }
        const { report, error } = parseOutput(req.output, final)
        req.log.write('result', report ?? error)
        return { report, usage, error, errorClass: error ? 'agent' : null }
      } catch (e) {
        return abort.signal.aborted ? fail(`timed out after ${req.timeoutMs}ms`, 'timeout') : fail(String(e))
      } finally {
        clearTimeout(timer)
        isolation.done()
      }
    },
  }
}
