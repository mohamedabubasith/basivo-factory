#!/usr/bin/env node
// Live check of the dev loop with real agents, before any tracker or CI is involved:
// a small repo with a bug, attempt 1 already failed in memory, then real attempts until the test passes or
// the cap is hit. Prints tokens, cost, tool use, memory use and claim honesty per attempt; logs every event.
//   node packages/cli/src/smoke.ts --runner claude|codex|both

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runnerFor } from '@basivo-factory/agents'
import { MAX_ATTEMPTS, type LogEvent } from '@basivo-factory/core'
import { blobShas, git, headCommit, MemoryStore } from '@basivo-factory/memory'
import { devStep } from './dev-step.ts'

const { values } = parseArgs({
  options: {
    runner: { type: 'string', default: 'both' },
    'claude-model': { type: 'string' },
    // The SDK's default Codex model may not be offered on a ChatGPT plan; pick one the account lists.
    'codex-model': { type: 'string', default: 'gpt-6-luna' },
  },
})
const modelFor = (name: 'claude' | 'codex') => (name === 'claude' ? values['claude-model'] : values['codex-model'])
const runners = values.runner === 'both' ? (['claude', 'codex'] as const) : [values.runner as 'claude' | 'codex']

const FILES: Record<string, string> = {
  'package.json': '{ "name": "cart", "type": "module", "scripts": { "test": "node --test" } }\n',
  'src/cart.js': `// Cart totals for the checkout page.
export function lineTotal(item) {
  return item.price
}

export function total(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0)
}
`,
  'src/format.js': `export const money = cents => (cents / 100).toFixed(2)\n`,
  'test/cart.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/cart.js'

test('a line costs price times quantity', () => {
  assert.equal(total([{ price: 2.5, qty: 4 }]), 10)
})

test('totals are rounded to whole cents', () => {
  assert.equal(total([{ price: 0.1, qty: 3 }]), 0.3)
})
`,
}

function fixtureRepo(dir: string) {
  for (const [path, body] of Object.entries(FILES)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'factory@example.com')
  git(dir, 'config', 'user.name', 'factory')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'cart')
}

function countTools(logFile: string) {
  const events = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l) as LogEvent)
  const calls = events.filter(e => e.kind === 'tool').map(e => (e.data as { name: string }).name)
  const errors = events.filter(e => e.kind === 'tool_result' && (e.data as { isError?: boolean }).isError).length
  return { calls: calls.length, errors, memory: calls.filter(n => n.startsWith('mcp__factory-memory')).map(n => n.split('__')[2]) }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const runRoot = resolve('.factory-runs', `smoke-${stamp}`)
const summary: Record<string, unknown>[] = []

for (const name of runners) {
  const base = join(runRoot, name)
  const repoDir = join(base, 'repo')
  const memoryRoot = join(base, 'memory')
  mkdirSync(repoDir, { recursive: true })
  fixtureRepo(repoDir)
  const store = new MemoryStore(memoryRoot)
  store.appendFact({
    repo: 'demo/cart', topic: 'run tests', body: 'Run the tests with npm test (node --test, no dependencies).',
    commit: headCommit(repoDir), blobs: blobShas(repoDir, ['package.json']), at: new Date().toISOString(),
  })
  store.appendAttempt({
    ticket: 'CART-7', step: 1, attempt: 1, commit: headCommit(repoDir), blobs: blobShas(repoDir, ['src/cart.js']),
    testCommand: 'npm test', result: 'fail',
    failureReason: 'totals are rounded to whole cents: expected 0.3, got 0.30000000000000004 (multiplied price by qty but did not round)',
    summary: 'multiplied price by qty in lineTotal', at: new Date().toISOString(),
  })

  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    console.error(`[${name}] attempt ${attempt}…`)
    const out = await devStep({
      repoDir, memoryRoot, repo: 'demo/cart', ticket: 'CART-7', title: 'Cart total ignores quantity',
      step: { n: 1, of: 1, task: 'total() must charge price × qty per line and round the total to whole cents', doneWhen: 'npm test', protect: ['test/'] },
      attempt, roundAttempt: attempt, files: ['src/cart.js', 'test/cart.test.js'], runner: runnerFor(name, modelFor(name)), runnerName: name, logDir: join(base, 'logs'),
    })
    const tools = countTools(out.logFile)
    const result = out.kind === 'retry_later' ? `retry later (${out.reason})` : out.attempt.result
    const row = {
      runner: name, attempt, test: result, fatal: out.kind === 'attempt' ? out.fatal : false,
      failureReason: out.kind === 'attempt' ? out.attempt.failureReason : null, agentError: out.agent?.error ?? null,
      briefTokens: out.briefTokens, ...out.agent?.usage, toolCalls: tools.calls, toolErrors: tools.errors,
      memoryTools: tools.memory.join(',') || '-',
      honest: out.kind === 'attempt' ? (out.claims?.honest ?? null) : null,
      claimedButUnchanged: (out.kind === 'attempt' && out.claims?.claimedButUnchanged.join(',')) || '-',
      changedButUnclaimed: (out.kind === 'attempt' && out.claims?.changedButUnclaimed.join(',')) || '-', log: out.logFile,
    }
    summary.push(row)
    console.error(`[${name}] attempt ${attempt}: ${result}`)
    if (out.kind === 'retry_later' || out.attempt.result === 'pass' || out.fatal) break
  }
}

writeFileSync(join(runRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify({ runRoot, summary }, null, 2))
