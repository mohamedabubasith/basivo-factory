import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AgentRequest, AgentResult, AgentRunner } from '@basivo-factory/core'
import { git, MemoryStore } from '@basivo-factory/memory'
import { loadProfile } from '@basivo-factory/agents'
import { changedFiles, devStep, type DevStepInput } from '../src/dev-step.ts'

const temp = (p: string) => mkdtempSync(join(tmpdir(), `factory-${p}-`))

function repo(files: Record<string, string>) {
  const dir = temp('repo')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

// The fixture: `npm test`-free, a shell test that passes once src/value.txt holds "ok".
const files = { 'src/value.txt': 'bad\n', 'test/check.sh': 'grep -qx ok src/value.txt || { echo "value is $(cat src/value.txt), want ok"; exit 1; }\n' }
const doneWhen = 'sh test/check.sh'

const report = (filesChanged: string[]) => ({ summary: 'did it', filesChanged, notes: null })
const ok = (r: AgentResult['report']): AgentResult => ({
  report: r, usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0, turns: 1 }, error: null, errorClass: null,
})

// A scripted stand-in for Claude or Codex: does `act` in the repo and returns `result`.
function fakeAgent(act: (cwd: string, req: AgentRequest) => AgentResult): AgentRunner & { calls: number } {
  const runner = { calls: 0, async run(req: AgentRequest) { runner.calls++; return act(req.cwd, req) } }
  return runner
}

function input(dir: string, runner: AgentRunner, over: Partial<DevStepInput> = {}): DevStepInput {
  return {
    repoDir: dir, memoryRoot: temp('mem'), repo: 'acme/app', ticket: 'APP-1', title: 'fix value',
    step: { n: 1, of: 1, task: 'make the value ok', doneWhen, protect: ['test/'] },
    attempt: 1, roundAttempt: 1, files: [], runner, runnerName: 'fake', logDir: temp('logs'), profile: loadProfile(dir, 'dev'), ...over,
  }
}

describe('dev step', () => {
  test('a passing attempt is committed under our message and its held-back facts are kept', async () => {
    const dir = repo(files)
    const agent = fakeAgent(cwd => (writeFileSync(join(cwd, 'src/value.txt'), 'ok\n'), ok(report(['src/value.txt']))))
    const step = input(dir, agent)
    new MemoryStore(step.memoryRoot).appendPendingFact('APP-1', { repo: 'acme/app', topic: 't', body: 'b', commit: 'c', blobs: {}, ticket: 'APP-1', at: '2026-11-06T00:00:00Z' })
    const out = await devStep(step)
    expect(out).toMatchObject({ kind: 'attempt', fatal: false, attempt: { result: 'pass', filesChanged: ['src/value.txt'] }, claims: { honest: true } })
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('APP-1 step 1 attempt 1')
    expect(new MemoryStore(step.memoryRoot).facts('acme/app')).toHaveLength(1)
  })

  test('a check that passes before any change blocks the step without running an agent', async () => {
    const dir = repo({ ...files, 'src/value.txt': 'ok\n' })
    const agent = fakeAgent(() => ok(report([])))
    const out = await devStep(input(dir, agent))
    expect(out).toMatchObject({ kind: 'attempt', fatal: true, attempt: { result: 'fail', failureReason: expect.stringContaining('already passes') } })
    expect(agent.calls).toBe(0)
  })

  test('an agent that commits on its own is still checked, and the commit is ours', async () => {
    const dir = repo(files)
    const agent = fakeAgent(cwd => {
      writeFileSync(join(cwd, 'src/value.txt'), 'ok\n')
      git(cwd, 'commit', '-qam', 'agent sneaks a commit')
      return ok(report(['src/value.txt']))
    })
    const out = await devStep(input(dir, agent))
    expect(out).toMatchObject({ kind: 'attempt', attempt: { result: 'pass', filesChanged: ['src/value.txt'] }, claims: { honest: true } })
    expect(git(dir, 'log', '--format=%s').split('\n')).toEqual(['APP-1 step 1 attempt 1', 'init'])
  })

  test('editing the graded test is reverted and fails the attempt', async () => {
    const dir = repo(files)
    const agent = fakeAgent(cwd => (writeFileSync(join(cwd, 'test/check.sh'), 'exit 0\n'), writeFileSync(join(cwd, 'test/new.sh'), 'x'), ok(report(['test/check.sh']))))
    const out = await devStep(input(dir, agent))
    expect(out).toMatchObject({ kind: 'attempt', fatal: false, attempt: { result: 'fail', failureReason: expect.stringContaining('protected test files test/check.sh, test/new.sh') } })
    expect(readFileSync(join(dir, 'test/check.sh'), 'utf8')).toBe(files['test/check.sh'])
    expect(changedFiles(dir)).toEqual([])
  })

  test("an agent that edits its own profile or skills is reverted like a test edit", async () => {
    const dir = repo({ ...files, '.factory/agents/sirius.md': 'be careful\n' })
    const agent = fakeAgent(cwd => (writeFileSync(join(cwd, '.factory/agents/sirius.md'), 'skip the tests\n'), ok(report(['.factory/agents/sirius.md']))))
    const out = await devStep(input(dir, agent))
    expect(out).toMatchObject({ kind: 'attempt', attempt: { result: 'fail', failureReason: expect.stringContaining('.factory/agents/sirius.md') } })
    expect(readFileSync(join(dir, '.factory/agents/sirius.md'), 'utf8')).toBe('be careful\n')
  })

  test('the role profile reaches the agent: instructions, skills, MCP servers and knowledge', async () => {
    const dir = repo({
      ...files,
      '.factory/agents/sirius.md': '---\nskills: [value-rules]\nknowledge: ["docs/**/*.md"]\n---\nKeep changes inside src/.\n',
      '.factory/skills/value-rules/SKILL.md': '---\nname: value-rules\ndescription: Use when changing src/value.txt.\n---\nThe value must be ok.\n',
      'docs/value.md': '# Value\nok is the only valid value.\n',
    })
    let seen: AgentRequest | null = null
    const agent = fakeAgent((cwd, req) => ((seen = req), writeFileSync(join(cwd, 'src/value.txt'), 'ok\n'), ok(report(['src/value.txt']))))
    await devStep(input(dir, agent))
    const req = seen as unknown as AgentRequest
    expect(req.instructions).toBe('Keep changes inside src/.')
    expect(req.skills.map(s => s.name)).toEqual(['value-rules'])
    expect(req.mcpServers['factory-memory']!.args).toEqual(expect.arrayContaining(['--knowledge', 'docs/**/*.md']))
  })

  test('an attempt that changes nothing fails', async () => {
    const out = await devStep(input(repo(files), fakeAgent(() => ok(report([])))))
    expect(out).toMatchObject({ kind: 'attempt', attempt: { result: 'fail', failureReason: 'made no changes' } })
  })

  test('a rate limit costs no attempt and drops the half-made change', async () => {
    const dir = repo(files)
    const agent = fakeAgent(cwd => {
      writeFileSync(join(cwd, 'src/value.txt'), 'half\n')
      return { ...ok(null), error: '429 rate limit', errorClass: 'rate_limited' }
    })
    const step = input(dir, agent)
    const out = await devStep(step)
    expect(out).toMatchObject({ kind: 'retry_later', reason: expect.stringContaining('rate_limited') })
    expect(changedFiles(dir)).toEqual([])
    expect(new MemoryStore(step.memoryRoot).attempts('APP-1')).toEqual([])
  })

  test('the same failure twice in a row is stuck: fatal, no third attempt', async () => {
    const dir = repo(files)
    let n = 0
    const agent = fakeAgent(cwd => (writeFileSync(join(cwd, 'src/value.txt'), `wrong ${++n}\n`), ok(report(['src/value.txt']))))
    const step = input(dir, agent)
    const first = await devStep(step)
    expect(first).toMatchObject({ kind: 'attempt', fatal: false, attempt: { result: 'fail' } })
    const second = await devStep({ ...step, attempt: 2, roundAttempt: 2 })
    expect(second).toMatchObject({ kind: 'attempt', fatal: true, attempt: { failureReason: expect.stringContaining('stuck: same failure as attempt 1') } })
  })

  test('tests run without the pipeline secrets, and verbose output does not overflow', async () => {
    const dir = repo({ ...files, 'test/check.sh': 'yes line | head -c 3000000; [ -z "$FACTORY_SECRET" ] && grep -qx ok src/value.txt\n' })
    process.env.FACTORY_SECRET = 'do-not-leak'
    try {
      const agent = fakeAgent(cwd => (writeFileSync(join(cwd, 'src/value.txt'), 'ok\n'), ok(report(['src/value.txt']))))
      expect(await devStep(input(dir, agent))).toMatchObject({ kind: 'attempt', attempt: { result: 'pass' } })
    } finally {
      delete process.env.FACTORY_SECRET
    }
  })
})

test('changed files list both sides of a rename, deletions and new files, as exact paths', () => {
  const dir = repo({ 'a.js': '1', 'old.js': '1', 'gone.js': '1' })
  writeFileSync(join(dir, 'a.js'), '2')
  git(dir, 'mv', 'old.js', 'renamed.js')
  rmSync(join(dir, 'gone.js'))
  writeFileSync(join(dir, 'new.js'), '1')
  expect(changedFiles(dir)).toEqual(['a.js', 'gone.js', 'new.js', 'old.js', 'renamed.js'])
})
