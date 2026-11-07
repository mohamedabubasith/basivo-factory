import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { runUpdate } = await import('../src/lib/projects.ts')

const ev = (kind: string, data: Record<string, unknown> = {}) => ({ ticket: 'BL-7', run: 'plan', ghRunId: 1, kind, data, at: '2026-11-08T00:00:00Z' })
const usage = [
  { costUsd: 0.04, inputTokens: 1000, cacheReadTokens: 10000, cacheWriteTokens: 5000, outputTokens: 900 },
  { costUsd: null, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
]

describe('runUpdate', () => {
  it('marks a finished plan as waiting for approval, with totals', () => {
    expect(runUpdate(ev('stage_finished', { stage: 'plan', usage }))).toEqual({
      status: 'waiting', stage: 'plan', detail: 'Plan posted, waiting for approval', costUsd: 0.04, inputTokens: 16000, outputTokens: 900,
    })
  })
  it('marks ship as done and failures as failed', () => {
    expect(runUpdate(ev('stage_finished', { stage: 'ship' }))).toMatchObject({ status: 'succeeded' })
    expect(runUpdate(ev('stage_failed', { stage: 'dev', error: 'blocked on step 2' }))).toMatchObject({ status: 'failed', detail: 'blocked on step 2' })
  })
  it('describes attempts and keeps the PR link', () => {
    expect(runUpdate(ev('attempt', { step: 2, of: 3, attempt: 1, result: 'fail' }))).toEqual({ detail: 'Step 2/3, try 1: fail' })
    expect(runUpdate(ev('pr_opened', { url: 'https://github.com/o/r/pull/3' }))).toEqual({ prUrl: 'https://github.com/o/r/pull/3' })
  })
  it('ignores unknown events', () => {
    expect(runUpdate(ev('something_new'))).toEqual({})
  })
})
