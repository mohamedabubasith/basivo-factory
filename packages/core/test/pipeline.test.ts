import { describe, expect, test } from 'vitest'
import { initialState, MAX_ATTEMPTS, MAX_STEPS, needsJob, next, roundAttempt, type Event, type State } from '../src/pipeline.ts'

const run = (events: Event[], from: State = initialState): State => events.reduce(next, from)
const approvedTwoSteps: Event[] = [{ type: 'intake_done' }, { type: 'plan_posted', steps: 2 }, { type: 'approved' }]

describe('pipeline', () => {
  test('happy path walks every step, then PR, merge and done', () => {
    const s = run([
      ...approvedTwoSteps,
      { type: 'dev_done' }, { type: 'test_passed' },
      { type: 'dev_done' }, { type: 'test_passed' },
      { type: 'pr_opened' }, { type: 'merged' },
    ])
    expect(s.stage).toBe('done')
  })

  test('a failed test retries the same step and remembers why', () => {
    const s = run([...approvedTwoSteps, { type: 'dev_done' }, { type: 'test_failed', reason: 'timeout in test_retry' }])
    expect(s).toMatchObject({ stage: 'dev', step: 1, attempt: 2, failures: ['timeout in test_retry'] })
  })

  test(`after ${MAX_ATTEMPTS} failures the ticket is blocked with every reason`, () => {
    const fail = (reason: string): Event[] => [{ type: 'dev_done' }, { type: 'test_failed', reason }]
    const s = run([...approvedTwoSteps, ...fail('a'), ...fail('b'), ...fail('c')])
    expect(s).toMatchObject({ stage: 'blocked', attempt: MAX_ATTEMPTS, failures: ['a', 'b', 'c'] })
    expect(needsJob(s.stage)).toBe(false)
  })

  test('a pass resets attempts for the next step', () => {
    const s = run([
      ...approvedTwoSteps,
      { type: 'dev_done' }, { type: 'test_failed', reason: 'x' },
      { type: 'dev_done' }, { type: 'test_passed' },
    ])
    expect(s).toMatchObject({ stage: 'dev', step: 2, attempt: 1, failures: [] })
  })

  test('a human retry gives a new round of attempts without reusing attempt numbers', () => {
    const blocked: State = { ...initialState, stage: 'blocked', step: 2, steps: 3, attempt: 3, failures: ['a', 'b', 'c'] }
    const retried = next(blocked, { type: 'retry' })
    expect(retried).toMatchObject({ stage: 'dev', step: 2, attempt: 4, attemptBase: 3, failures: [] })
    expect(roundAttempt(retried)).toEqual({ n: 1, of: MAX_ATTEMPTS })
    const fail = (reason: string): Event[] => [{ type: 'dev_done' }, { type: 'test_failed', reason }]
    expect(run([...fail('d'), ...fail('e'), ...fail('f')], retried)).toMatchObject({ stage: 'blocked', attempt: 6 })
  })

  test('a fatal failure blocks at once instead of spending the remaining attempts', () => {
    const s = run([...approvedTwoSteps, { type: 'dev_done' }, { type: 'test_failed', reason: 'stuck', fatal: true }])
    expect(s).toMatchObject({ stage: 'blocked', attempt: 1, failures: ['stuck'] })
  })

  test('changes requested sends the plan back with the note', () => {
    const s = run([{ type: 'intake_done' }, { type: 'plan_posted', steps: 1 }, { type: 'changes_requested', note: 'use OAuth' }])
    expect(s).toMatchObject({ stage: 'plan', note: 'use OAuth' })
  })

  test('events out of order are refused', () => {
    expect(() => next(initialState, { type: 'approved' })).toThrow('not valid in stage intake')
    expect(() => run([{ type: 'intake_done' }, { type: 'plan_posted', steps: 0 }])).toThrow('at least one step')
    expect(() => run([{ type: 'intake_done' }, { type: 'plan_posted', steps: MAX_STEPS + 1 }])).toThrow('split the ticket')
  })

  test('only working stages need a CI job', () => {
    expect(['intake', 'plan', 'dev', 'test', 'pr'].every(s => needsJob(s as State['stage']))).toBe(true)
    expect(['awaiting_approval', 'awaiting_merge', 'done', 'blocked'].some(s => needsJob(s as State['stage']))).toBe(false)
  })
})
