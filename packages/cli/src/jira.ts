// Jira Cloud as the tracker: the ticket is a Jira work item, comments and status moves go to its board.
// REST v2 for comments (it takes wiki markup, so the pipeline's markdown keeps its bold, code and links),
// v3 for the rest. Auth: an Atlassian API token with the account's email (basic auth).

import type { Ticket, TicketStatus, Tracker } from '@basivo-factory/core'

// Board columns a normal team uses. A status with no column here (awaiting approval) leaves the ticket where
// it is; blocked raises Jira's flag instead of moving the card.
export const JIRA_COLUMNS: Partial<Record<TicketStatus, string>> = {
  in_progress: 'In Progress',
  in_review: 'Code Review',
  done: 'Done',
}

export const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/

type Adf = { type: string; text?: string; content?: Adf[]; attrs?: Record<string, unknown> }

// Atlassian Document Format (Jira's rich text) to plain text with markdown-ish lists and headings,
// which is all an agent needs from a ticket description.
export function adfToText(node: Adf | null | undefined, list = ''): string {
  if (!node) return ''
  const inner = (sep = '') => (node.content ?? []).map(c => adfToText(c, list)).join(sep)
  switch (node.type) {
    case 'text': return node.text ?? ''
    case 'hardBreak': return '\n'
    case 'paragraph': return `${inner()}\n\n`
    case 'heading': return `${'#'.repeat(Number(node.attrs?.level ?? 2))} ${inner()}\n\n`
    case 'codeBlock': return `\`\`\`\n${inner()}\n\`\`\`\n\n`
    case 'bulletList': return `${(node.content ?? []).map(c => `- ${adfToText(c, list).trim()}`).join('\n')}\n\n`
    case 'orderedList': return `${(node.content ?? []).map((c, i) => `${i + 1}. ${adfToText(c, list).trim()}`).join('\n')}\n\n`
    default: return inner()
  }
}

// The pipeline writes markdown; Jira's v2 comment API renders wiki markup.
export function markdownToWiki(md: string): string {
  const blocks = md.split(/(```[\s\S]*?```)/)
  return blocks.map(b => b.startsWith('```')
    ? b.replace(/^```\w*\n?/, '{code}\n').replace(/\n?```$/, '\n{code}')
    : b
      .replace(/^### (.*)$/gm, 'h3. $1').replace(/^## (.*)$/gm, 'h2. $1').replace(/^# (.*)$/gm, 'h1. $1')
      .replace(/^(\s*)- /gm, (_, s: string) => `${'*'.repeat(s.length / 3 + 1)} `)
      .replace(/^(\s*)\d+\. /gm, (_, s: string) => `${'#'.repeat(s.length / 3 + 1)} `)
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/`([^`]+)`/g, '{{$1}}')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]'),
  ).join('')
}

export function jira({ baseUrl, email, token }: { baseUrl: string; email: string; token: string }): Tracker {
  const site = baseUrl.replace(/\/+$/, '')
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${site}/rest/api/${path}`, {
      method,
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Jira ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    return (res.status === 204 ? null : await res.json()) as T
  }
  const check = (key: string) => {
    if (!JIRA_KEY.test(key)) throw new Error(`not a Jira key: ${key}`)
    return key
  }

  return {
    async get(key) {
      const issue = await call<{ fields: { summary: string; description: Adf | null } }>('GET', `3/issue/${check(key)}?fields=summary,description`)
      return { key, title: issue.fields.summary, description: adfToText(issue.fields.description).trim(), url: `${site}/browse/${key}` } satisfies Ticket
    },
    async comment(key, markdown) {
      await call('POST', `2/issue/${check(key)}/comment`, { body: markdownToWiki(markdown) })
    },
    async transition(key, status) {
      check(key)
      if (status === 'blocked') {
        // Jira's flag (the red marker on the card) is a custom field whose id differs per site.
        const fields = await call<{ id: string; name: string }[]>('GET', '3/field')
        const flagged = fields.find(f => f.name === 'Flagged')
        if (flagged) await call('PUT', `3/issue/${key}`, { fields: { [flagged.id]: [{ value: 'Impediment' }] } })
        else await call('PUT', `3/issue/${key}`, { update: { labels: [{ add: 'blocked' }] } })
        return
      }
      const column = JIRA_COLUMNS[status]
      if (!column) return
      const { transitions } = await call<{ transitions: { id: string; to: { name: string } }[] }>('GET', `3/issue/${key}/transitions`)
      const t = transitions.find(x => x.to.name.toLowerCase() === column.toLowerCase())
      if (!t) {
        console.warn(`Jira: ${key} has no transition to "${column}"; left where it is`)
        return
      }
      await call('POST', `3/issue/${key}/transitions`, { transition: { id: t.id } })
    },
  }
}
