// GitHub as tracker and forge: an issue is the ticket, labels carry its stage, and the change ships as a PR.
// Plain fetch on the REST API with the job's GITHUB_TOKEN; the same Tracker port Jira and YouTrack implement.

import type { Ticket, TicketStatus, Tracker } from '@basivo-factory/core'

export type GitHub = Tracker & {
  openPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }>
  runUrl(): string
}

const STATUS_LABEL: Record<TicketStatus, string> = {
  in_progress: 'factory: building',
  awaiting_approval: 'factory: awaiting approval',
  blocked: 'factory: blocked',
  in_review: 'factory: in review',
  done: 'factory: done',
}
const COLOR = { 'factory: building': '1d76db', 'factory: awaiting approval': 'fbca04', 'factory: blocked': 'b60205', 'factory: in review': '5319e7', 'factory: done': '0e8a16' }

export function github({ token, repo, api = 'https://api.github.com' }: { token: string; repo: string; api?: string }): GitHub {
  const call = async <T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> => {
    const res = await fetch(`${api}/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'basivo-factory' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    return (res.status === 204 ? null : await res.json()) as T
  }
  const number = (key: string) => key.replace(/^\D+/, '')

  return {
    async get(key) {
      const issue = await call<{ title: string; body: string | null; html_url: string }>('GET', `/issues/${number(key)}`)
      return { key, title: issue.title, description: issue.body ?? '', url: issue.html_url } satisfies Ticket
    },
    async comment(key, markdown) {
      await call('POST', `/issues/${number(key)}/comments`, { body: markdown })
    },
    // One factory label at a time shows where the ticket stands.
    async transition(key, status) {
      const label = STATUS_LABEL[status]
      await call('POST', '/labels', { name: label, color: COLOR[label as keyof typeof COLOR] }, [422]) // 422: already exists
      for (const other of Object.values(STATUS_LABEL).filter(l => l !== label)) {
        await call('DELETE', `/issues/${number(key)}/labels/${encodeURIComponent(other)}`, undefined, [404])
      }
      await call('POST', `/issues/${number(key)}/labels`, { labels: [label] })
    },
    async openPullRequest({ head, base, title, body }) {
      const [owner] = repo.split('/')
      const existing = await call<{ html_url: string; number: number }[]>('GET', `/pulls?head=${owner}:${head}&state=open`)
      if (existing[0]) {
        await call('PATCH', `/pulls/${existing[0].number}`, { body })
        return { url: existing[0].html_url, number: existing[0].number }
      }
      const pr = await call<{ html_url: string; number: number }>('POST', '/pulls', { head, base, title, body })
      return { url: pr.html_url, number: pr.number }
    },
    runUrl: () => `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`,
  }
}
