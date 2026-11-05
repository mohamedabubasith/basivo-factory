import { expect, test } from 'vitest'
import { AgentReport, Attempt } from '../src/ledger.ts'

test('an attempt line round-trips and rejects a missing test result', () => {
  const line = {
    ticket: 'PROJ-12', step: 1, attempt: 2, commit: 'abc123',
    blobs: { 'server/webhooks.ts': '9f2c' }, testCommand: 'pnpm test',
    result: 'fail', failureReason: 'timeout', summary: 'added retry', at: '2026-11-06T10:00:00Z',
  }
  expect(Attempt.parse(JSON.parse(JSON.stringify(line)))).toEqual(line)
  expect(Attempt.safeParse({ ...line, result: undefined }).success).toBe(false)
})

test('an agent report cannot claim test results', () => {
  const report = AgentReport.parse({ summary: 'done', filesChanged: ['a.ts'], notes: null, testsPassed: true })
  expect(report).not.toHaveProperty('testsPassed')
})
