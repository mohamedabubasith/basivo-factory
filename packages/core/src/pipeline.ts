// The ticket's stage machine. Pure: CI jobs load the state, apply what happened, save it, and dispatch
// the job the new stage needs. Waiting stages need no job, so no runner ever sits idle waiting for a human.

export const MAX_ATTEMPTS = 3

export type Stage = 'intake' | 'plan' | 'awaiting_approval' | 'dev' | 'test' | 'pr' | 'awaiting_merge' | 'done' | 'blocked'

export type State = {
  stage: Stage
  step: number // 1-based plan step being built
  steps: number // plan size, 0 until planned
  attempt: number // 1..MAX_ATTEMPTS for the current step
  failures: string[] // failure reasons for the current step, oldest first
  note: string | null // the human's change request, for the next plan run
}

export type Event =
  | { type: 'intake_done' }
  | { type: 'plan_posted'; steps: number }
  | { type: 'approved' }
  | { type: 'changes_requested'; note: string }
  | { type: 'dev_done' }
  | { type: 'test_passed' }
  | { type: 'test_failed'; reason: string }
  | { type: 'pr_opened' }
  | { type: 'merged' }
  | { type: 'retry' } // a human unblocks a ticket after reading its failures

export const initialState: State = { stage: 'intake', step: 0, steps: 0, attempt: 0, failures: [], note: null }

const JOB_STAGES: ReadonlySet<Stage> = new Set(['intake', 'plan', 'dev', 'test', 'pr'])

export function needsJob(stage: Stage): boolean {
  return JOB_STAGES.has(stage)
}

const freshStep = (s: State, step: number): State => ({ ...s, stage: 'dev', step, attempt: 1, failures: [] })

export function next(s: State, e: Event): State {
  switch (`${s.stage}:${e.type}`) {
    case 'intake:intake_done':
      return { ...s, stage: 'plan' }
    case 'plan:plan_posted': {
      const { steps } = e as Extract<Event, { type: 'plan_posted' }>
      if (!Number.isInteger(steps) || steps < 1) throw new Error(`a plan needs at least one step, got ${steps}`)
      return { ...s, stage: 'awaiting_approval', steps, note: null }
    }
    case 'awaiting_approval:approved':
      return freshStep(s, 1)
    case 'awaiting_approval:changes_requested':
      return { ...s, stage: 'plan', note: (e as Extract<Event, { type: 'changes_requested' }>).note }
    case 'dev:dev_done':
      return { ...s, stage: 'test' }
    case 'test:test_passed':
      return s.step < s.steps ? freshStep(s, s.step + 1) : { ...s, stage: 'pr', failures: [] }
    case 'test:test_failed': {
      const failures = [...s.failures, (e as Extract<Event, { type: 'test_failed' }>).reason]
      return s.attempt < MAX_ATTEMPTS
        ? { ...s, stage: 'dev', attempt: s.attempt + 1, failures }
        : { ...s, stage: 'blocked', failures }
    }
    case 'pr:pr_opened':
      return { ...s, stage: 'awaiting_merge' }
    case 'awaiting_merge:merged':
      return { ...s, stage: 'done' }
    case 'blocked:retry':
      return freshStep(s, s.step)
  }
  throw new Error(`event ${e.type} is not valid in stage ${s.stage}`)
}
