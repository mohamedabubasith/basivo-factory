import { afterEach, describe, expect, it, vi } from 'vitest'
import { githubForge } from '../src/forge/github.ts'

type Call = { method: string; url: string; body: unknown }

function mockFetch(routes: Record<string, (c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const key = Object.keys(routes).find(k => `${c.method} ${url}`.includes(k))
    if (!key) return new Response('not mocked', { status: 500 })
    return routes[key]!(c)
  }))
  return calls
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
const forge = () => githubForge({ token: 't', repo: 'o/r', api: 'https://api.test' })

describe('github forge', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads a pull request, spotting forks and bots', async () => {
    mockFetch({ 'GET https://api.test/repos/o/r/pulls/7': () => json({
      number: 7, title: 'Add discounts', body: null, draft: false, state: 'open', html_url: 'u', user: { login: 'dependabot[bot]', type: 'Bot' },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'o/r' } }, head: { ref: 'feat', sha: 'h'.repeat(40), repo: { full_name: 'x/r' } },
    }) })
    const pr = await forge().change(7)
    expect(pr).toMatchObject({ body: '', authorIsBot: true, fromFork: true, base: { ref: 'main' } })
  })

  it('pages through the file list and maps statuses', async () => {
    mockFetch({
      'GET https://api.test/repos/o/r/pulls/7/files?per_page=100': () => json([{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }], 200, { link: '<https://api.test/page2>; rel="next"' }),
      'GET https://api.test/page2': () => json([{ filename: 'c.ts', previous_filename: 'b.ts', status: 'renamed' }, { filename: 'x.png', status: 'added' }]),
    })
    const files = await forge().files(7)
    expect(files).toEqual([
      { path: 'a.ts', previousPath: null, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'c.ts', previousPath: 'b.ts', status: 'renamed', patch: null },
      { path: 'x.png', previousPath: null, status: 'added', patch: null },
    ])
  })

  it('returns null for a file missing at the ref', async () => {
    mockFetch({ 'GET https://api.test/repos/o/r/contents/src/a.ts?ref=h': () => new Response('nope', { status: 404 }) })
    expect(await forge().fileAt('src/a.ts', 'h')).toBeNull()
  })

  it('posts one review, and falls back to single comments when the batch is rejected', async () => {
    const calls = mockFetch({
      'POST https://api.test/repos/o/r/pulls/7/reviews': () => new Response('{"message":"line not part of diff"}', { status: 422 }),
      'POST https://api.test/repos/o/r/pulls/7/comments': c => ((c.body as { line: number }).line === 99 ? new Response('bad', { status: 422 }) : json({ id: 1 })),
    })
    const r = await forge().postInline(7, 'h', [{ path: 'a.ts', line: 1, side: 'RIGHT', body: 'x' }, { path: 'a.ts', line: 99, side: 'RIGHT', body: 'y' }])
    expect(r).toEqual({ posted: 1, failed: [{ path: 'a.ts', line: 99, side: 'RIGHT', body: 'y' }] })
    expect(calls[0]!.body).toMatchObject({ commit_id: 'h', event: 'COMMENT' })
  })

  it('edits the summary in place when the marker is already there', async () => {
    const calls = mockFetch({
      'GET https://api.test/repos/o/r/issues/7/comments': () => json([{ id: 5, body: '<!-- m -->\nold', html_url: 'u5' }, { id: 6, body: 'other', html_url: 'u6' }]),
      'PATCH https://api.test/repos/o/r/issues/comments/5': () => json({ id: 5, html_url: 'u5' }),
    })
    expect(await forge().upsertSummary(7, '<!-- m -->', 'new')).toBe('u5')
    expect(calls.at(-1)!.body).toEqual({ body: '<!-- m -->\nnew' })
  })

  it('collects fingerprints from earlier inline comments', async () => {
    mockFetch({ 'GET https://api.test/repos/o/r/pulls/7/comments': () => json([{ body: 'text <!-- basivo-review fp=0123456789abcdef -->' }, { body: 'plain' }]) })
    expect([...await forge().postedFingerprints(7)]).toEqual(['0123456789abcdef'])
  })

  it('summarises check runs, ignoring its own', async () => {
    mockFetch({ 'GET https://api.test/repos/o/r/commits/h/check-runs': () => json({ check_runs: [
      { name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'in_progress', conclusion: null }, { name: 'basivo-review', status: 'in_progress', conclusion: null },
    ] }) })
    expect(await forge().ciStatus('h')).toEqual({ state: 'pending', detail: '1 of 2 checks still running' })
  })
})
