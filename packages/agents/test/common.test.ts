import { expect, test } from 'vitest'
import { agentEnv, classifyError, parseReport, reportJsonSchema } from '../src/common.ts'

test('the report schema is strict, as Codex requires', () => {
  const schema = reportJsonSchema() as { additionalProperties: boolean; required: string[] }
  expect(schema.additionalProperties).toBe(false)
  expect(schema).not.toHaveProperty('$schema') // Claude Code rejects the draft 2020-12 reference
  expect([...schema.required].sort()).toEqual(['filesChanged', 'notes', 'summary'])
})

test('a report parses from an object or JSON text, and junk is an error, not a crash', () => {
  const report = { summary: 'fixed sum', filesChanged: ['sum.js'], notes: null }
  expect(parseReport(report).report).toEqual(report)
  expect(parseReport(JSON.stringify(report)).report).toEqual(report)
  expect(parseReport('not json')).toMatchObject({ report: null, error: expect.stringContaining('invalid report') })
})

test('the agent environment keeps the toolchain and the given credential, nothing else', () => {
  process.env.GITHUB_TOKEN = 'ghp_secret'
  process.env.JIRA_API_TOKEN = 'secret'
  try {
    const env = agentEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: undefined })
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env).not.toHaveProperty('JIRA_API_TOKEN')
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
  } finally {
    delete process.env.GITHUB_TOKEN
    delete process.env.JIRA_API_TOKEN
  }
})

test('failures that retrying later fixes are told apart from agent failures', () => {
  expect(classifyError('API Error: 429 Too Many Requests')).toBe('rate_limited')
  expect(classifyError("You've hit your usage limit. Upgrade or try again later")).toBe('quota')
  expect(classifyError('401 Unauthorized: invalid api key')).toBe('auth')
  expect(classifyError("The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.")).toBe('startup')
  expect(classifyError('timed out after 900000ms')).toBe('timeout')
  expect(classifyError('invalid report: expected string')).toBe('agent')
})
