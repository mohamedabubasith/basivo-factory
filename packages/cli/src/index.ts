#!/usr/bin/env node
// What every CI job runs. M0: `next` applies one event to a saved state; stage jobs are wired in M3.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { initialState, needsJob, next, type Event, type State } from '@basivo-factory/core'

const USAGE = `usage:
  factory next --state <file> --event '<json>'   apply one event; prints the new stage and whether it needs a job
  factory stage <name> --ticket <KEY>            run one pipeline stage (wired in M3)`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { state: { type: 'string' }, event: { type: 'string' }, ticket: { type: 'string' } },
})

const [command, name] = positionals

if (command === 'next' && values.state && values.event) {
  let state: State = initialState
  try {
    state = JSON.parse(readFileSync(values.state, 'utf8')) as State
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e // a new ticket has no state file yet
  }
  const after = next(state, JSON.parse(values.event) as Event)
  writeFileSync(values.state, `${JSON.stringify(after, null, 2)}\n`)
  console.log(JSON.stringify({ stage: after.stage, needsJob: needsJob(after.stage) }))
} else if (command === 'stage' && name && values.ticket) {
  console.error(`stage ${name} for ${values.ticket}: not wired yet (milestone M3)`)
  process.exit(2)
} else {
  console.error(USAGE)
  process.exit(1)
}
