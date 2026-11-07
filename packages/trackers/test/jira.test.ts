import { afterEach, describe, expect, it, vi } from 'vitest'
import { adfToText, jira, JIRA_KEY, markdownToWiki } from '../src/jira.ts'

describe('adfToText', () => {
  it('turns a Jira description into plain text with headings and lists', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'As a PM, I want variants.' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Returns 201' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Weights add up to 100' }] }] },
        ] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'GET /api/assign' }] },
      ],
    }
    expect(adfToText(doc).trim()).toBe(
      'As a PM, I want variants.\n\n## Acceptance criteria\n\n- Returns 201\n- Weights add up to 100\n\n```\nGET /api/assign\n```')
  })
  it('handles an empty description', () => {
    expect(adfToText(null)).toBe('')
  })
})

describe('markdownToWiki', () => {
  it('keeps bold, code, links and lists readable in Jira', () => {
    expect(markdownToWiki('**Polaris** planned `BL-7`. [Run](https://x.y/1)\n1. Step one\n   - done when: `pnpm test`'))
      .toBe('*Polaris* planned {{BL-7}}. [Run|https://x.y/1]\n# Step one\n** done when: {{pnpm test}}')
  })
  it('turns fenced code into a code macro', () => {
    expect(markdownToWiki('```js\nconst a = 1\n```')).toBe('{code}\nconst a = 1\n{code}')
  })
})

describe('JIRA_KEY', () => {
  it('accepts keys and rejects anything that could reach a shell or a path', () => {
    expect(JIRA_KEY.test('BL-7')).toBe(true)
    expect(JIRA_KEY.test('PROJ2-123')).toBe(true)
    for (const bad of ['bl-7', 'BL-7; rm -rf /', '../BL-7', 'BL-', '$(id)']) expect(JIRA_KEY.test(bad)).toBe(false)
  })
})

describe('jira tracker', () => {
  afterEach(() => vi.unstubAllGlobals())
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const tracker = () => jira({ baseUrl: 'https://acme.atlassian.net/', email: 'a@b.c', token: 't' })

  it('moves the ticket to the board column for the status', async () => {
    const calls: [string, RequestInit][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init])
      if (init.method === 'GET') return json({ transitions: [{ id: '11', to: { name: 'To Do' } }, { id: '31', to: { name: 'Code Review' } }] })
      return new Response(null, { status: 204 })
    }))
    await tracker().transition('BL-7', 'in_review')
    expect(calls[1]![0]).toBe('https://acme.atlassian.net/rest/api/3/issue/BL-7/transitions')
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ transition: { id: '31' } })
    expect(String((calls[0]![1].headers as Record<string, string>).authorization)).toMatch(/^Basic /)
  })

  it('flags the card when blocked instead of moving it', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') return json([{ id: 'customfield_10021', name: 'Flagged' }])
      bodies.push(JSON.parse(String(init.body)))
      return new Response(null, { status: 204 })
    }))
    await tracker().transition('BL-7', 'blocked')
    expect(bodies).toEqual([{ fields: { customfield_10021: [{ value: 'Impediment' }] } }])
  })

  it('leaves the ticket alone for statuses without a column', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await tracker().transition('BL-7', 'awaiting_approval')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a malformed key before calling Jira', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(tracker().comment('BL-7/../x', 'hi')).rejects.toThrow(/not a Jira key/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads a ticket with its link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ fields: { summary: 'Create an experiment', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] } } })))
    expect(await tracker().get('BL-8')).toEqual({ key: 'BL-8', title: 'Create an experiment', description: 'Body', url: 'https://acme.atlassian.net/browse/BL-8' })
  })
})
