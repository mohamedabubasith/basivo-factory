import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Attempt } from '@basivo-factory/core'
import { blobShas, changedPaths, git } from '../src/git.ts'
import { buildIndex, toFtsQuery } from '../src/search.ts'
import { MemoryStore } from '../src/store.ts'
import { commitAndPush } from '../src/sync.ts'
import { repoWith, tempDir } from './fixture.ts'

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  ticket: 'PROJ-12', step: 1, attempt: 1, commit: 'abc', blobs: { 'a.ts': '1' }, testCommand: 'pnpm test',
  result: 'fail', failureReason: 'timeout', summary: 'added retry', at: '2026-11-06T10:00:00Z', ...over,
})

describe('staleness', () => {
  test('an edited or deleted file shows up as changed, an untouched one does not', () => {
    const repo = repoWith({ 'a.ts': 'one', 'b.ts': 'two', 'c.ts': 'three' })
    const recorded = blobShas(repo.dir, ['a.ts', 'b.ts', 'c.ts'])
    expect(Object.keys(recorded)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    repo.commit({ 'a.ts': 'one, edited' })
    git(repo.dir, 'rm', '-q', 'c.ts')
    git(repo.dir, 'commit', '-q', '-m', 'drop c')
    expect(changedPaths(recorded, blobShas(repo.dir, ['a.ts', 'b.ts', 'c.ts']))).toEqual(['a.ts', 'c.ts'])
  })
})

describe('store', () => {
  test('attempts and facts round-trip through their jsonl files', () => {
    const store = new MemoryStore(tempDir('mem'))
    store.appendAttempt(attempt())
    store.appendAttempt(attempt({ attempt: 2, result: 'pass', failureReason: null }))
    expect(store.attempts('PROJ-12').map(a => a.attempt)).toEqual([1, 2])
    expect(store.attempts('PROJ-99')).toEqual([])
    expect(store.tickets()).toEqual(['PROJ-12'])
  })

  test('keys that could escape the store are refused', () => {
    const store = new MemoryStore(tempDir('mem'))
    expect(() => store.attempts('../etc')).toThrow('invalid ticket key')
    expect(() => store.facts('owner/../x')).toThrow('invalid repo')
    expect(() => store.facts('just-a-name')).toThrow('invalid repo')
  })

  test('a corrupt line is reported with its file and line, not skipped', () => {
    const root = tempDir('mem')
    const store = new MemoryStore(root)
    store.appendAttempt(attempt())
    writeFileSync(join(root, 'tickets/PROJ-12/attempts.jsonl'), `${JSON.stringify(attempt())}\n{"ticket":"PROJ-12"}\n`)
    expect(() => store.attempts('PROJ-12')).toThrow(/attempts\.jsonl:2/)
  })
})

describe('search', () => {
  const index = buildIndex([
    { id: 'clock', text: 'timeout in test_webhook_retry: mock clock not advanced' },
    { id: 'auth', text: 'login fails when the session cookie is missing' },
  ])

  test('finds the past failure that matches an error message', () => {
    expect(index.search('Error: timeout waiting for mock clock', 5)[0]?.id).toBe('clock')
  })

  test('punctuation cannot break the query, and empty text finds nothing', () => {
    expect(toFtsQuery('a "quoted" (thing) OR NOT*')).toBe('"quoted" OR "thing" OR "or" OR "not"')
    expect(index.search('?? !!', 5)).toEqual([])
  })
})

describe('sync', () => {
  test('a job that lost the push race rebases and pushes again', () => {
    const origin = tempDir('origin')
    git(origin, 'init', '-q', '--bare', '-b', 'factory-memory')
    const clone = (name: string) => {
      const dir = tempDir(name)
      git(dir, 'init', '-q', '-b', 'factory-memory')
      git(dir, 'config', 'user.email', 'job@example.com')
      git(dir, 'config', 'user.name', name)
      git(dir, 'remote', 'add', 'origin', origin)
      return dir
    }
    const seed = clone('seed')
    writeFileSync(join(seed, 'README'), 'memory\n')
    expect(commitAndPush(seed, 'seed')).toBe(true)

    const [jobA, jobB] = [clone('a'), clone('b')]
    for (const dir of [jobA, jobB]) git(dir, 'pull', '-q', 'origin', 'factory-memory')
    new MemoryStore(jobA).appendAttempt(attempt({ ticket: 'PROJ-1' }))
    new MemoryStore(jobB).appendAttempt(attempt({ ticket: 'PROJ-2' }))
    expect(commitAndPush(jobA, 'PROJ-1 attempt 1')).toBe(true)
    expect(commitAndPush(jobB, 'PROJ-2 attempt 1')).toBe(true) // behind jobA: rebases, then pushes

    const check = clone('check')
    git(check, 'pull', '-q', 'origin', 'factory-memory')
    expect(new MemoryStore(check).tickets().sort()).toEqual(['PROJ-1', 'PROJ-2'])
    expect(commitAndPush(check, 'nothing')).toBe(false)
  })
})
