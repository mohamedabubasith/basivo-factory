import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRequest, AgentResult, AgentRunner } from '@basivo-factory/core'
import { describe, expect, it } from 'vitest'
import { isGenerated, setup, survey } from '../src/onboard.ts'

const g = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'bfr-setup-'))
  g(dir, 'init', '-q', '-b', 'main')
  const w = (p: string, t: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), t) }
  w('package.json', '{"name":"shop","scripts":{"test":"vitest run"}}')
  w('src/cart.js', 'export const total = () => 1')
  w('src/api/routes.js', 'export const routes = []')
  w('test/cart.test.js', 'test("x", () => {})')
  w('.factory/knowledge/money.md', '---\ntitle: Money\nreviewed: 2026-11-01\n---\nRound once.')
  w('.factory/knowledge/old.md', '---\ntitle: Old\nreviewed: 2020-01-01\nsources: [src/cart.js]\ngenerated: true\n---\nstale')
  g(dir, 'add', '-A')
  g(dir, 'commit', '-qm', 'init')
  return { dir, w }
}

describe('survey', () => {
  it('summarises the tree, manifests, CI, docs and tooling without reading everything', () => {
    const paths = ['package.json', 'README.md', 'src/a.ts', 'src/b.ts', 'src/deep/x/y/z.ts', 'test/a.test.ts', '.github/workflows/ci.yml', 'docs/adr/0001.md', 'tsconfig.json']
    const s = survey(paths, p => (p === 'package.json' ? '{"name":"x"}' : null))
    expect(s.files).toBe(9)
    expect(s.topFolders[0]).toBe('src')
    expect(s.text).toContain('src/ (3)')
    expect(s.text).toContain('CI: .github/workflows/ci.yml')
    expect(s.text).toContain('Docs: README.md, docs/adr/0001.md')
    expect(s.text).toContain('Tooling: tsconfig.json')
    expect(s.text).toContain('--- package.json\n{"name":"x"}')
  })
  it('recognises generated docs', () => {
    expect(isGenerated('---\ngenerated: true\n---\nx')).toBe(true)
    expect(isGenerated('---\ntitle: t\n---\nx')).toBe(false)
  })
})

// A runner that writes what the test tells it to, including things it must not.
function scripted(writes: Record<string, string>, commit = false): { runner: AgentRunner; requests: AgentRequest<unknown>[] } {
  const requests: AgentRequest<unknown>[] = []
  return {
    requests,
    runner: {
      async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
        requests.push(req)
        for (const [p, t] of Object.entries(writes)) { mkdirSync(join(req.cwd, p, '..'), { recursive: true }); writeFileSync(join(req.cwd, p), t) }
        if (commit) { g(req.cwd, 'add', '-A'); g(req.cwd, 'commit', '-qm', 'oops') }
        return { report: { written: Object.keys(writes), skipped: [], notes: 'done' } as T, usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.5, turns: 3 }, error: null, errorClass: null }
      },
    },
  }
}

describe('setup', () => {
  it('plans without a model in dry-run mode', async () => {
    const { dir } = repo()
    const r = await setup({ repoDir: dir, runner: scripted({}).runner, logDir: null, ci: null, reviewTemplate: null, readmeTemplate: 'readme', dryRun: true })
    expect(r.written).toEqual(['.factory/review.md', '.factory/knowledge/README.md'])
    expect(r.notes[0]).toContain('.factory/knowledge/overview.md')
    expect(r.notes[0]).toContain('.factory/knowledge/old.md') // stale generated doc is regenerated
    expect(r.kept).toEqual(['.factory/knowledge/money.md'])
  })

  it('keeps generated docs, protects team docs, reverts stray edits and undoes commits', async () => {
    const { dir } = repo()
    const { runner, requests } = scripted({
      '.factory/knowledge/overview.md': '---\ntitle: Overview\nreviewed: 2026-11-10\nsources: [package.json]\ngenerated: true\n---\nShop.',
      '.factory/knowledge/money.md': 'REWRITTEN BY THE MODEL',
      'src/cart.js': 'export const total = () => 2',
    }, true)
    const r = await setup({ repoDir: dir, runner, logDir: null, ci: 'github', reviewTemplate: 'name: review', readmeTemplate: null, now: () => new Date('2026-11-10') })
    expect(readFileSync(join(dir, '.factory/knowledge/overview.md'), 'utf8')).toContain('Shop.')
    expect(readFileSync(join(dir, '.factory/knowledge/money.md'), 'utf8')).toContain('Round once.')
    expect(readFileSync(join(dir, 'src/cart.js'), 'utf8')).toBe('export const total = () => 1')
    expect(readFileSync(join(dir, '.github/workflows/review.yml'), 'utf8')).toBe('name: review')
    expect(r.reverted.sort()).toEqual(['.factory/knowledge/money.md', 'src/cart.js'])
    expect(r.written).toEqual(expect.arrayContaining(['.factory/review.md', '.github/workflows/review.yml', '.factory/knowledge/overview.md']))
    expect(g(dir, 'log', '--oneline').split('\n')).toHaveLength(1) // the model's commit was undone
    expect(r.usage).toEqual({ costUsd: 0.5, runs: 1 })
    const req = requests[0]!
    expect(req.access).toBe('write')
    expect(req.brief).toContain('never touch: .factory/knowledge/money.md')
    expect(req.brief).toContain('Today is 2026-11-10')
  })
})
