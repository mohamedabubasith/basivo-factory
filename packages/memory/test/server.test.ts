import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, test } from 'vitest'
import { blobShas, headCommit } from '../src/git.ts'
import { createMemoryServer } from '../src/server.ts'
import { MemoryStore } from '../src/store.ts'
import { repoWith, tempDir } from './fixture.ts'

async function connect() {
  const repo = repoWith({ 'server/webhooks.ts': 'export const retry = 1', 'package.json': '{}' })
  const store = new MemoryStore(tempDir('mem'))
  const server = createMemoryServer({ store, repoDir: repo.dir, repo: 'acme/shop', ticket: 'PROJ-12', now: () => new Date('2026-11-06T10:00:00Z') })
  const client = new Client({ name: 'test', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as { text: string }[])[0]!.text
    return { isError: result.isError === true, value: JSON.parse(text) }
  }
  return { repo, store, client, call }
}

test('the server offers exactly the four memory tools', async () => {
  const { client } = await connect()
  expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['facts', 'ledger', 'record_fact', 'similar'])
})

test('the ledger marks an attempt stale once the file it touched changes', async () => {
  const { repo, store, call } = await connect()
  store.appendAttempt({
    ticket: 'PROJ-12', step: 1, attempt: 1, commit: headCommit(repo.dir),
    blobs: blobShas(repo.dir, ['server/webhooks.ts']), testCommand: 'pnpm test',
    result: 'fail', failureReason: 'timeout: mock clock not advanced', summary: 'added retry', at: '2026-11-06T09:00:00Z',
  })
  expect((await call('ledger', { ticket: 'PROJ-12' })).value[0]).toMatchObject({ stale: false, failureReason: 'timeout: mock clock not advanced' })

  repo.commit({ 'server/webhooks.ts': 'export const retry = 3' })
  expect((await call('ledger', { ticket: 'PROJ-12' })).value[0]).toMatchObject({ stale: true, changedPaths: ['server/webhooks.ts'] })
})

test('a recorded fact comes back by topic once its attempt passes, and similar finds it', async () => {
  const { call, store } = await connect()
  const saved = await call('record_fact', { topic: 'run tests', body: 'Use pnpm test; the webhook tests need FAKE_CLOCK=1.', paths: ['package.json'] })
  expect(saved.value).toMatchObject({ saved: true })
  expect((await call('facts', {})).value).toEqual([]) // held back until the attempt passes
  store.settlePendingFacts('PROJ-12', true)
  expect((await call('facts', { topic: 'how to run the tests' })).value[0]).toMatchObject({ topic: 'run tests', ticket: 'PROJ-12', stale: false })
  expect((await call('similar', { text: 'webhook test fails, clock?' })).value[0]).toMatchObject({ kind: 'fact', topic: 'run tests' })
})

test('a fact about a file the repo does not track is refused', async () => {
  const { call } = await connect()
  const result = await call('record_fact', { topic: 'x', body: 'y', paths: ['nope.ts'] })
  expect(result).toMatchObject({ isError: true, value: { error: 'not tracked at HEAD: nope.ts' } })
})
