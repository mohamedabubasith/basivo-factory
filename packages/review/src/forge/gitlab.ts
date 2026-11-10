// GitLab merge requests through the REST API (v4), self-hosted or gitlab.com: the base URL is a setting.
// Token: a project/group access token with the `api` scope (CI_JOB_TOKEN cannot create notes).

import type { FilePatch } from '../hunks.ts'
import { FINGERPRINT_RE, type ChangeRequest, type CiStatus, type Forge, type InlineComment, type PostResult } from './types.ts'

export class GitLabError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type DiffRefs = { base_sha: string; head_sha: string; start_sha: string }

export function gitlabForge({ token, project, host = process.env.GITLAB_HOST ?? process.env.CI_SERVER_URL ?? 'https://gitlab.com' }: { token: string; project: string; host?: string }): Forge {
  const base = `${host.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(project)}`
  const headers = { 'PRIVATE-TOKEN': token, 'user-agent': 'basivo-review' }
  const call = async <T>(method: string, path: string, body?: unknown, ok: number[] = [], raw = false): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok && !ok.includes(res.status)) throw new GitLabError(res.status, `GitLab ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    if (!res.ok || res.status === 204) return null as T
    return (raw ? await res.text() : await res.json()) as T
  }
  // GitLab pages with x-next-page.
  const paged = async <T>(path: string): Promise<T[]> => {
    const out: T[] = []
    let page = '1'
    while (page) {
      const res: Response = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { headers })
      if (!res.ok) throw new GitLabError(res.status, `GitLab GET ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
      out.push(...(await res.json() as T[]))
      page = res.headers.get('x-next-page') ?? ''
    }
    return out
  }

  const refs = new Map<number, DiffRefs>()
  const oldPaths = new Map<number, Map<string, string>>() // iid → new path → old path (renames)
  const enc = (p: string) => encodeURIComponent(p)

  return {
    kind: 'gitlab',
    repo: project,

    async change(iid) {
      type Mr = { iid: number; title: string; description: string | null; draft: boolean; state: string; web_url: string
        author: { username: string; bot?: boolean }; source_project_id: number; target_project_id: number
        source_branch: string; target_branch: string; diff_refs: DiffRefs | null; sha: string }
      const m = await call<Mr>('GET', `/merge_requests/${iid}`)
      if (m.diff_refs) refs.set(iid, m.diff_refs)
      return {
        number: m.iid, title: m.title, body: m.description ?? '', draft: m.draft, open: m.state === 'opened', url: m.web_url,
        author: m.author.username, authorIsBot: m.author.bot === true || /bot$/i.test(m.author.username),
        fromFork: m.source_project_id !== m.target_project_id,
        base: { ref: m.target_branch, sha: m.diff_refs?.base_sha ?? '' }, head: { ref: m.source_branch, sha: m.diff_refs?.head_sha ?? m.sha },
      } satisfies ChangeRequest
    },

    async files(iid) {
      type D = { old_path: string; new_path: string; new_file: boolean; renamed_file: boolean; deleted_file: boolean; diff: string; too_large?: boolean; collapsed?: boolean }
      const diffs = await paged<D>(`/merge_requests/${iid}/diffs`)
      oldPaths.set(iid, new Map(diffs.map(d => [d.new_path, d.old_path])))
      return diffs.map(d => ({
        path: d.deleted_file ? d.old_path : d.new_path,
        previousPath: d.renamed_file ? d.old_path : null,
        status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
        patch: d.too_large || d.collapsed || !d.diff || /^Binary files/.test(d.diff) ? null : d.diff,
      } satisfies FilePatch))
    },

    async fileAt(path, ref) {
      return call<string | null>('GET', `/repository/files/${enc(path)}/raw?ref=${enc(ref)}`, undefined, [404], true)
    },

    async listDir(path, ref) {
      try {
        const tree = await paged<{ path: string; type: string }>(`/repository/tree?path=${enc(path)}&ref=${enc(ref)}&recursive=true`)
        return tree.filter(e => e.type === 'blob').map(e => e.path)
      } catch (e) {
        if (e instanceof GitLabError && e.status === 404) return []
        throw e
      }
    },

    async ciStatus(sha) {
      type S = { name: string; status: string }
      const all = await paged<S>(`/repository/commits/${sha}/statuses`)
      const own = process.env.CI_JOB_NAME
      const mine = all.filter(s => s.name !== own && !/basivo-review/i.test(s.name))
      if (mine.length === 0) return { state: 'none', detail: 'no pipeline jobs' } satisfies CiStatus
      const failed = mine.filter(s => s.status === 'failed')
      const pending = mine.filter(s => ['pending', 'running', 'created', 'waiting_for_resource', 'preparing', 'scheduled'].includes(s.status))
      if (failed.length) return { state: 'failure', detail: `failing: ${failed.map(s => s.name).join(', ')}` }
      if (pending.length) return { state: 'pending', detail: `${pending.length} of ${mine.length} jobs still running` }
      return { state: 'success', detail: `${mine.length} jobs passed` }
    },

    // One discussion per comment, anchored with the merge request's diff refs. An anchor GitLab refuses (400)
    // is reported as failed and shown in the summary instead.
    async postInline(iid, headSha, comments): Promise<PostResult> {
      if (comments.length === 0) return { posted: 0, failed: [] }
      const r = refs.get(iid) ?? (await this.change(iid), refs.get(iid))
      if (!r) return { posted: 0, failed: comments }
      const olds = oldPaths.get(iid) ?? new Map<string, string>()
      const failed: InlineComment[] = []
      let posted = 0
      for (const c of comments) {
        const position: Record<string, unknown> = {
          position_type: 'text', base_sha: r.base_sha, start_sha: r.start_sha, head_sha: headSha,
          new_path: c.path, old_path: olds.get(c.path) ?? c.path,
          ...(c.side === 'LEFT' ? { old_line: c.line } : { new_line: c.line }),
        }
        try {
          await call('POST', `/merge_requests/${iid}/discussions`, { body: c.body, position })
          posted++
        } catch (e) {
          if (!(e instanceof GitLabError) || e.status !== 400) throw e
          failed.push(c)
        }
      }
      return { posted, failed }
    },

    async upsertSummary(iid, marker, body) {
      type N = { id: number; body: string; system: boolean }
      const existing = (await paged<N>(`/merge_requests/${iid}/notes`)).find(n => !n.system && n.body.includes(marker))
      const text = `${marker}\n${body}`
      const mrUrl = `${host.replace(/\/+$/, '')}/${project}/-/merge_requests/${iid}`
      if (existing) {
        await call('PUT', `/merge_requests/${iid}/notes/${existing.id}`, { body: text })
        return `${mrUrl}#note_${existing.id}`
      }
      const n = await call<N>('POST', `/merge_requests/${iid}/notes`, { body: text })
      return `${mrUrl}#note_${n.id}`
    },

    async postedFingerprints(iid) {
      const out = new Set<string>()
      for (const d of await paged<{ notes: { body: string }[] }>(`/merge_requests/${iid}/discussions`)) {
        for (const n of d.notes) for (const m of n.body.matchAll(FINGERPRINT_RE)) out.add(m[1]!)
      }
      return out
    },
  }
}
