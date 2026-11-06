// OpenAI Codex through @openai/codex-sdk. A new thread per run; the MCP servers are passed as config.
// Auth: ~/.codex/auth.json from a ChatGPT login (subscription) or CODEX_API_KEY / OPENAI_API_KEY.
// Codex has no turn or budget cap, so the wall-clock timeout is the cap, and it reports tokens, not USD.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Codex, type ThreadEvent } from '@openai/codex-sdk'
import { preview, type AgentRequest, type AgentResult, type AgentRunner, type Usage } from '@basivo-factory/core'
import { parseReport, reportJsonSchema, SYSTEM_PROMPT } from './common.ts'

// Each run gets an empty CODEX_HOME holding only the login, and HOME pointing at the same empty folder,
// so the user's own config, AGENTS.md, memories and ~/.agents/skills never reach the agent. A login Codex
// refreshes during the run is copied back, because the refresh rotates the token and the old copy would stop
// working.
function isolatedHome(): { env: Record<string, string>; done(): void } {
  const realHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const realAuth = join(realHome, 'auth.json')
  const home = mkdtempSync(join(tmpdir(), 'factory-codex-'))
  const auth = join(home, 'auth.json')
  const before = existsSync(realAuth) ? readFileSync(realAuth, 'utf8') : null
  if (before !== null) copyFileSync(realAuth, auth)
  return {
    env: { CODEX_HOME: home, HOME: home },
    done() {
      if (before !== null && existsSync(auth) && readFileSync(auth, 'utf8') !== before) copyFileSync(auth, realAuth)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

// process.env minus undefined values, as the SDK's env option takes only strings.
const stringEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

function logEvent(req: AgentRequest, ev: ThreadEvent) {
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
    async run(req: AgentRequest): Promise<AgentResult> {
      const home = isolatedHome()
      const codex = new Codex({
        env: { ...stringEnv(), ...home.env },
        config: {
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
      })
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), req.timeoutMs)
      const usage: Usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: null, turns: null }
      req.log.write('start', { runner: 'codex', model: model ?? 'default', access: req.access, briefChars: req.brief.length })
      let final = ''
      try {
        const { events } = await thread.runStreamed(`${SYSTEM_PROMPT}\n\n${req.brief}`, { outputSchema: reportJsonSchema(), signal: abort.signal })
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
          if (ev.type === 'turn.failed') throw new Error(ev.error.message)
        }
        const { report, error } = parseReport(final)
        req.log.write('result', report ?? error)
        return { report, usage, error }
      } catch (e) {
        const error = abort.signal.aborted ? `timed out after ${req.timeoutMs}ms` : String(e)
        req.log.write('error', error)
        return { report: null, usage, error }
      } finally {
        clearTimeout(timer)
        home.done()
      }
    },
  }
}
