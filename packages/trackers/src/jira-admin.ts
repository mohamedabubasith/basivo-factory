// Jira calls the dashboard makes while setting a project up: who am I, which projects and statuses exist,
// and the webhook that tells the dashboard when a ticket moves or gets a comment (instead of hand-made
// Jira Automation rules). Same basic auth as the tracker: an Atlassian API token with the account's email.

export type JiraAuth = { baseUrl: string; email: string; token: string }

export function jiraAdmin({ baseUrl, email, token }: JiraAuth) {
  const site = baseUrl.replace(/\/+$/, '')
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(site)) throw new Error('Jira site must look like https://your-team.atlassian.net')
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${site}/rest/${path}`, {
      method,
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Jira ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    return (res.status === 204 ? null : await res.json()) as T
  }

  return {
    site,
    myself: () => call<{ accountId: string; displayName: string }>('GET', 'api/3/myself'),

    async projects(): Promise<{ key: string; name: string }[]> {
      const r = await call<{ values: { key: string; name: string }[] }>('GET', 'api/3/project/search?maxResults=100&orderBy=name')
      return r.values.map(p => ({ key: p.key, name: p.name }))
    },

    // Every status any work type in the project can be in, without duplicates.
    async statuses(projectKey: string): Promise<string[]> {
      const types = await call<{ statuses: { name: string }[] }[]>('GET', `api/3/project/${encodeURIComponent(projectKey)}/statuses`)
      return [...new Set(types.flatMap(t => t.statuses.map(s => s.name)))]
    },

    // Admin webhook limited to one project. Jira signs deliveries with the secret (X-Hub-Signature).
    async createWebhook(input: { name: string; url: string; projectKey: string; secret: string }): Promise<string> {
      const r = await call<{ self: string }>('POST', 'webhooks/1.0/webhook', {
        name: input.name,
        url: input.url,
        events: ['jira:issue_updated', 'comment_created'],
        filters: { 'issue-related-events-section': `project = "${input.projectKey}"` },
        excludeBody: false,
        secret: input.secret,
      })
      const id = r.self.split('/').pop()
      if (!id) throw new Error('Jira did not return the webhook id')
      return id
    },
    async webhookExists(id: string): Promise<boolean> {
      try {
        await call('GET', `webhooks/1.0/webhook/${encodeURIComponent(id)}`)
        return true
      } catch {
        return false
      }
    },
    async deleteWebhook(id: string) {
      await call('DELETE', `webhooks/1.0/webhook/${encodeURIComponent(id)}`).catch(() => undefined)
    },
  }
}
