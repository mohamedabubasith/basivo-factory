// GitHub pull requests through the REST API with one token: the Actions GITHUB_TOKEN on a runner, or
// `gh auth token` on a developer's machine. Plain fetch, no SDK.

import type { FilePatch } from '../hunks.ts'
import { FINGERPRINT_RE, type ChangeRequest, type CiStatus, type Forge, type InlineComment, type PostResult } from './types.ts'

export class GitHubError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function githubForge({ token, repo, api = process.env.GITHUB_API_URL ?? 'https://api.github.com' }: { token: string; repo: string; api?: string }): Forge {
  const call = async <T>(method: string, path: string, body?: unknown, ok: number[] = [], raw = false): Promise<T> => {
    const res = await fetch(path.startsWith('http') ? path : `${api}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'basivo-review',
        accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok && !ok.includes(res.status)) throw new GitHubError(res.status, `GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    if (ok.includes(res.status) && !res.ok) return null as T
    if (res.status === 204) return null as T
    return (raw ? await res.text() : await res.json()) as T
  }
  // Follows Link: rel="next" until the end.
  const paged = async <T>(path: string): Promise<T[]> => {
    const out: T[] = []
    let url: string | null = `${api}/repos/${repo}${path}${path.includes('?') ? '&' : '?'}per_page=100`
    while (url) {
      const res: Response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'basivo-review' } })
      if (!res.ok) throw new GitHubError(res.status, `GitHub GET ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
      out.push(...(await res.json() as T[]))
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null
    }
    return out
  }

  return {
    kind: 'github',
    repo,

    async change(number) {
      type Pr = { number: number; title: string; body: string | null; draft: boolean; state: string; html_url: string
        user: { login: string; type: string }; base: { ref: string; sha: string; repo: { full_name: string } }; head: { ref: string; sha: string; repo: { full_name: string } | null } }
      const p = await call<Pr>('GET', `/pulls/${number}`)
      return {
        number: p.number, title: p.title, body: p.body ?? '', draft: p.draft, open: p.state === 'open', url: p.html_url,
        author: p.user.login, authorIsBot: p.user.type === 'Bot' || p.user.login.endsWith('[bot]'),
        fromFork: p.head.repo === null || p.head.repo.full_name !== p.base.repo.full_name,
        base: { ref: p.base.ref, sha: p.base.sha }, head: { ref: p.head.ref, sha: p.head.sha },
      } satisfies ChangeRequest
    },

    async files(number) {
      type F = { filename: string; previous_filename?: string; status: string; patch?: string }
      const status = (s: string): FilePatch['status'] => (s === 'added' || s === 'removed' || s === 'renamed' ? s : 'modified')
      return (await paged<F>(`/pulls/${number}/files`)).map(f => ({
        path: f.filename, previousPath: f.previous_filename ?? null, status: status(f.status), patch: f.patch ?? null,
      }))
    },

    async fileAt(path, ref) {
      const text = await call<string | null>('GET', `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, undefined, [404, 403], true)
      return text
    },

    async listDir(path, ref) {
      type T = { tree: { path: string; type: string }[]; truncated: boolean }
      const t = await call<T | null>('GET', `/git/trees/${encodeURIComponent(ref)}:${path.split('/').map(encodeURIComponent).join('/')}?recursive=1`, undefined, [404])
      return t ? t.tree.filter(e => e.type === 'blob').map(e => `${path}/${e.path}`) : []
    },

    async ciStatus(sha) {
      type Runs = { check_runs: { name: string; status: string; conclusion: string | null }[] }
      const { check_runs: runs } = await call<Runs>('GET', `/commits/${sha}/check-runs?per_page=100`)
      const mine = runs.filter(r => !/basivo-review/i.test(r.name))
      if (mine.length === 0) return { state: 'none', detail: 'no checks' } satisfies CiStatus
      const failed = mine.filter(r => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion))
      const pending = mine.filter(r => r.status !== 'completed')
      if (failed.length) return { state: 'failure', detail: `failing: ${failed.map(r => r.name).join(', ')}` }
      if (pending.length) return { state: 'pending', detail: `${pending.length} of ${mine.length} checks still running` }
      return { state: 'success', detail: `${mine.length} checks passed` }
    },

    // One review holding every comment; if GitHub rejects the batch (one bad anchor fails all of them), post
    // them one by one so the good ones still land and the bad ones are reported.
    async postInline(number, headSha, comments): Promise<PostResult> {
      if (comments.length === 0) return { posted: 0, failed: [] }
      try {
        await call('POST', `/pulls/${number}/reviews`, { commit_id: headSha, event: 'COMMENT', comments })
        return { posted: comments.length, failed: [] }
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 422) throw e
      }
      const failed: InlineComment[] = []
      let posted = 0
      for (const c of comments) {
        try {
          await call('POST', `/pulls/${number}/comments`, { commit_id: headSha, ...c })
          posted++
        } catch (e) {
          if (!(e instanceof GitHubError) || e.status !== 422) throw e
          failed.push(c)
        }
      }
      return { posted, failed }
    },

    async upsertSummary(number, marker, body) {
      type C = { id: number; body: string; html_url: string }
      const existing = (await paged<C>(`/issues/${number}/comments`)).find(c => c.body.includes(marker))
      const text = `${marker}\n${body}`
      if (existing) return (await call<C>('PATCH', `/issues/comments/${existing.id}`, { body: text })).html_url
      return (await call<C>('POST', `/issues/${number}/comments`, { body: text })).html_url
    },

    async postedFingerprints(number) {
      const out = new Set<string>()
      for (const c of await paged<{ body: string }>(`/pulls/${number}/comments`)) {
        for (const m of c.body.matchAll(FINGERPRINT_RE)) out.add(m[1]!)
      }
      return out
    },
  }
}
