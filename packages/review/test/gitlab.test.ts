import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitlabForge } from '../src/forge/gitlab.ts'

type Call = { method: string; url: string; body: unknown }
function mockFetch(routes: Record<string, (c: Call) => Response>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const key = Object.keys(routes).find(k => `${c.method} ${url}`.includes(k))
    return key ? routes[key]!(c) : new Response('not mocked', { status: 500 })
  }))
  return calls
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
const P = 'https://git.example.com/api/v4/projects/team%2Fshop'
const forge = () => gitlabForge({ token: 't', project: 'team/shop', host: 'https://git.example.com/' })
const mr = { iid: 5, title: 'Add discount', description: null, draft: false, state: 'opened', web_url: 'https://git.example.com/team/shop/-/merge_requests/5',
  author: { username: 'abu' }, source_project_id: 1, target_project_id: 1, source_branch: 'feat', target_branch: 'main',
  diff_refs: { base_sha: 'b'.repeat(40), head_sha: 'h'.repeat(40), start_sha: 's'.repeat(40) }, sha: 'h'.repeat(40) }

describe('gitlab forge', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads a merge request with its diff refs', async () => {
    mockFetch({ [`GET ${P}/merge_requests/5`]: () => json(mr) })
    expect(await forge().change(5)).toMatchObject({ number: 5, body: '', open: true, fromFork: false, base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: 'h'.repeat(40) } })
  })

  it('maps diffs, renames, deletions and binaries, following x-next-page', async () => {
    mockFetch({
      [`GET ${P}/merge_requests/5/diffs?per_page=100&page=1`]: () => json([{ old_path: 'a.ts', new_path: 'a.ts', new_file: false, renamed_file: false, deleted_file: false, diff: '@@ -1 +1 @@\n-a\n+b' }], 200, { 'x-next-page': '2' }),
      [`GET ${P}/merge_requests/5/diffs?per_page=100&page=2`]: () => json([
        { old_path: 'b.ts', new_path: 'c.ts', new_file: false, renamed_file: true, deleted_file: false, diff: '' },
        { old_path: 'gone.ts', new_path: 'gone.ts', new_file: false, renamed_file: false, deleted_file: true, diff: '@@ -1 +0,0 @@\n-x' },
        { old_path: 'x.png', new_path: 'x.png', new_file: true, renamed_file: false, deleted_file: false, diff: 'Binary files differ' },
      ]),
    })
    expect(await forge().files(5)).toEqual([
      { path: 'a.ts', previousPath: null, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'c.ts', previousPath: 'b.ts', status: 'renamed', patch: null },
      { path: 'gone.ts', previousPath: null, status: 'removed', patch: '@@ -1 +0,0 @@\n-x' },
      { path: 'x.png', previousPath: null, status: 'added', patch: null },
    ])
  })

  it('posts discussions with a text position and reports refused anchors', async () => {
    const calls = mockFetch({
      [`GET ${P}/merge_requests/5/diffs`]: () => json([{ old_path: 'old.ts', new_path: 'a.ts', new_file: false, renamed_file: true, deleted_file: false, diff: '@@ -1 +1 @@\n-a\n+b' }]),
      [`GET ${P}/merge_requests/5`]: () => json(mr),
      [`POST ${P}/merge_requests/5/discussions`]: c => ((c.body as { position: { new_line?: number } }).position.new_line === 99 ? new Response('{"message":"line_code"}', { status: 400 }) : json({ id: 'd1' })),
    })
    const f = forge()
    await f.files(5)
    const r = await f.postInline(5, 'h'.repeat(40), [{ path: 'a.ts', line: 1, side: 'RIGHT', body: 'x' }, { path: 'a.ts', line: 99, side: 'RIGHT', body: 'y' }, { path: 'a.ts', line: 1, side: 'LEFT', body: 'z' }])
    expect(r.posted).toBe(2)
    expect(r.failed.map(c => c.line)).toEqual([99])
    const first = calls.find(c => c.method === 'POST')!.body as { position: Record<string, unknown> }
    expect(first.position).toEqual({ position_type: 'text', base_sha: 'b'.repeat(40), start_sha: 's'.repeat(40), head_sha: 'h'.repeat(40), new_path: 'a.ts', old_path: 'old.ts', new_line: 1 })
    const left = calls.filter(c => c.method === 'POST').at(-1)!.body as { position: Record<string, unknown> }
    expect(left.position).toMatchObject({ old_line: 1 })
    expect(left.position).not.toHaveProperty('new_line')
  })

  it('edits the summary note in place and finds fingerprints in discussions', async () => {
    const calls = mockFetch({
      [`GET ${P}/merge_requests/5/notes`]: () => json([{ id: 9, body: 'x <!-- m -->', system: false }, { id: 10, body: 'added 1 commit', system: true }]),
      [`PUT ${P}/merge_requests/5/notes/9`]: () => json({ id: 9 }),
      [`GET ${P}/merge_requests/5/discussions`]: () => json([{ notes: [{ body: 'a <!-- basivo-review fp=0123456789abcdef -->' }] }, { notes: [{ body: 'plain' }] }]),
    })
    expect(await forge().upsertSummary(5, '<!-- m -->', 'new')).toBe('https://git.example.com/team/shop/-/merge_requests/5#note_9')
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ body: '<!-- m -->\nnew' })
    expect([...await forge().postedFingerprints(5)]).toEqual(['0123456789abcdef'])
  })

  it('summarises commit statuses, skipping its own job', async () => {
    vi.stubEnv('CI_JOB_NAME', 'review')
    mockFetch({ [`GET ${P}/repository/commits/h/statuses`]: () => json([{ name: 'test', status: 'success' }, { name: 'review', status: 'running' }]) })
    expect(await forge().ciStatus('h')).toEqual({ state: 'success', detail: '1 jobs passed' })
    vi.unstubAllEnvs()
  })

  it('returns [] for a missing directory and null for a missing file', async () => {
    mockFetch({ [`GET ${P}/repository/tree`]: () => new Response('{"message":"404 Tree Not Found"}', { status: 404 }), [`GET ${P}/repository/files/`]: () => new Response('', { status: 404 }) })
    expect(await forge().listDir('.factory/knowledge', 'main')).toEqual([])
    expect(await forge().fileAt('.factory/review.md', 'main')).toBeNull()
  })
})
