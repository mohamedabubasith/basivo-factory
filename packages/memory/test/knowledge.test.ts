import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, test } from 'vitest'
import { git } from '../src/git.ts'
import { loadKnowledge, readKnowledge, searchKnowledge, staleness } from '../src/knowledge.ts'
import { createMemoryServer } from '../src/server.ts'
import { MemoryStore } from '../src/store.ts'
import { repoWith, tempDir } from './fixture.ts'

const NOW = new Date('2026-11-06T00:00:00Z')

const docs = {
  'src/money.js': 'export const round = x => x\n',
  'docs/adr/0001-money.md': '---\ntitle: Money is rounded once\nsummary: Round the sum to cents once.\nreviewed: 2026-10-01\nsources: [src/money.js]\n---\n# Money\nLine totals stay unrounded.\nRound once at the end.\n',
  'docs/runbooks/deploy.md': '# Deploy\nRun the release workflow; never deploy on Fridays.\n',
  'docs/old.md': '---\nreviewed: 2025-01-01\n---\n# Old auth notes\nSessions use cookies.\n',
  'notes.txt': 'not markdown',
}

test('docs load with their frontmatter, or a heading and first lines when they have none', () => {
  const repo = repoWith(docs)
  const loaded = loadKnowledge(repo.dir, ['docs/**/*.md', 'notes.txt'])
  expect(loaded.map(d => d.path)).toEqual(['docs/adr/0001-money.md', 'docs/old.md', 'docs/runbooks/deploy.md'])
  expect(loaded[0]).toMatchObject({ title: 'Money is rounded once', reviewed: '2026-10-01', sources: ['src/money.js'] })
  expect(loaded[2]).toMatchObject({ title: 'Deploy', reviewed: null })
})

test('a doc is stale when never reviewed, reviewed long ago, or its sources changed after review', () => {
  const repo = repoWith(docs)
  const [money, old, deploy] = loadKnowledge(repo.dir, ['docs/**/*.md'])
  expect(staleness(repo.dir, deploy!, NOW)).toEqual(['never reviewed'])
  expect(staleness(repo.dir, old!, NOW)).toEqual([expect.stringMatching(/^reviewed \d+ days ago$/)])
  // The fixture's commits happen today, after the 2026-10-01 review, so the source counts as changed.
  expect(staleness(repo.dir, money!, NOW)).toEqual(['sources changed since review: src/money.js'])
  git(repo.dir, 'log', '-1') // sanity: the repo has history
})

test('search finds the right doc and reads it by line range', () => {
  const repo = repoWith(docs)
  const loaded = loadKnowledge(repo.dir, ['docs/**/*.md'])
  expect(searchKnowledge(repo.dir, loaded, 'how do we round money totals', 3, NOW)[0]).toMatchObject({ path: 'docs/adr/0001-money.md', stale: true })
  expect(readKnowledge(loaded[0]!, 2, 2)).toEqual({ path: 'docs/adr/0001-money.md', totalLines: 4, text: '2: Line totals stay unrounded.\n3: Round once at the end.' })
})

test('kb tools appear only when the role has knowledge, and kb_read refuses files outside it', async () => {
  const repo = repoWith(docs)
  const connect = async (knowledge: string[]) => {
    const server = createMemoryServer({ store: new MemoryStore(tempDir('mem')), repoDir: repo.dir, repo: 'acme/shop', ticket: 'T-1', knowledge, now: () => NOW })
    const client = new Client({ name: 't', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return client
  }
  expect((await (await connect([])).listTools()).tools.map(t => t.name)).not.toContain('kb_search')
  const client = await connect(['docs/**/*.md'])
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['kb_search', 'kb_read']))
  const hit = await client.callTool({ name: 'kb_search', arguments: { query: 'deploy on Fridays' } })
  expect(JSON.parse((hit.content as { text: string }[])[0]!.text)[0]).toMatchObject({ path: 'docs/runbooks/deploy.md', stale: true, why: ['never reviewed'] })
  const outside = await client.callTool({ name: 'kb_read', arguments: { path: 'src/money.js' } })
  expect(outside.isError).toBe(true)
})
