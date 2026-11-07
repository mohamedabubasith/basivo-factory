// Runs against a real Postgres when TEST_DATABASE_URL is set (skipped otherwise):
//   TEST_DATABASE_URL=postgres://factory@localhost:54329/dash pnpm vitest run apps/dashboard/test/db.integration.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('dashboard database and endpoints', async () => {
  process.env.DATABASE_URL = url
  process.env.FACTORY_SECRET = 'test-secret-'.repeat(4)
  process.env.ADMIN_GITHUB_LOGINS = 'mohamedabubasith'
  const { db, projects, runs, runEvents, connections } = await import('../src/lib/db.ts')
  const { saveConnection, getConnection, connectionSummary } = await import('../src/lib/connections.ts')
  const { sha256, hmacHex, encrypt } = await import('../src/lib/crypto.ts')
  const { appKeys } = await import('../src/lib/env.ts')
  const ingestRoute = await import('../src/app/api/ingest/route.ts')
  const jiraRoute = await import('../src/app/api/webhooks/jira/[id]/route.ts')
  const { eq, sql } = await import('drizzle-orm')

  let projectId = 0
  beforeAll(async () => {
    const d = await db()
    await d.execute(sql`truncate factory.projects, factory.runs, factory.run_events, factory.connections, factory.audit_log restart identity cascade`)
    const [p] = await d.insert(projects).values({
      name: 'BL → o/basivo-lab', jiraProject: 'BL', repo: 'o/basivo-lab', installationId: 1, startStatus: 'Selected for Development',
      approvers: ['acc-me'], ingestTokenHash: sha256('ingest-tok'), webhookTokenHash: sha256('hook-tok'),
      webhookSecret: encrypt(appKeys().secrets, 'hook-secret'),
    }).returning()
    projectId = p!.id
  })
  afterAll(async () => {
    await (await db()).execute(sql`drop schema factory cascade`)
  })

  it('keeps connection secrets encrypted at rest and readable through the helper', async () => {
    await saveConnection('claude', { config: { kind: 'oauth' }, secret: { token: 'sk-ant-oat01-abc' } })
    const [row] = await (await db()).select().from(connections).where(eq(connections.kind, 'claude'))
    expect(row!.secret).toMatch(/^v1\./)
    expect(row!.secret).not.toContain('sk-ant')
    expect((await getConnection('claude'))!.secret.token).toBe('sk-ant-oat01-abc')
    expect(JSON.stringify(await connectionSummary())).not.toContain('sk-ant')
  })

  const post = (body: unknown, token = 'ingest-tok') => ingestRoute.POST(new Request('http://x/api/ingest', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }))
  const ev = (kind: string, data: Record<string, unknown> = {}, ticket = 'BL-7') => ({ ticket, run: 'plan', ghRunId: 900, kind, data, at: new Date().toISOString() })

  it('records live progress and moves the run through its states', async () => {
    expect((await post(ev('stage_started', { stage: 'intake' }))).status).toBe(202)
    expect((await post(ev('plan_posted', { summary: 's', steps: [{ task: 'a', doneWhen: 'x' }] }))).status).toBe(202)
    expect((await post(ev('stage_finished', { stage: 'plan', usage: [{ costUsd: 0.04, inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 }] }))).status).toBe(202)
    const [run] = await (await db()).select().from(runs).where(eq(runs.ghRunId, 900))
    expect(run).toMatchObject({ projectId, ticket: 'BL-7', status: 'waiting', costUsd: 0.04, inputTokens: 6, outputTokens: 4 })
    const events = await (await db()).select().from(runEvents).where(eq(runEvents.runId, run!.id))
    expect(events.map(e => e.kind)).toEqual(['stage_started', 'plan_posted', 'stage_finished'])
    expect(events[2]!.data).not.toHaveProperty('usage')
  })

  it('rejects a wrong token, a ticket of another project and malformed events', async () => {
    expect((await post(ev('stage_started'), 'wrong')).status).toBe(401)
    expect((await post(ev('stage_started', {}, 'BAS-1'))).status).toBe(403)
    expect((await post({ ...ev('stage_started'), ticket: 'BL-7; rm -rf /' })).status).toBe(400)
    expect((await post({ ...ev('stage_started'), kind: 'DROP TABLE' })).status).toBe(400)
  })

  const hook = (body: unknown, opts: { token?: string; sign?: string | null } = {}) => {
    const text = JSON.stringify(body)
    const headers: Record<string, string> = {}
    if (opts.sign !== null) headers['x-hub-signature'] = `sha256=${hmacHex(opts.sign ?? 'hook-secret', text)}`
    const { NextRequest } = require('next/server') as typeof import('next/server')
    return jiraRoute.POST(new NextRequest(`http://x/api/webhooks/jira/${projectId}?token=${opts.token ?? 'hook-tok'}`, { method: 'POST', body: text, headers }),
      { params: Promise.resolve({ id: String(projectId) }) })
  }

  it('checks the Jira webhook token and signature before anything else', async () => {
    const moved = { webhookEvent: 'jira:issue_updated', user: { accountId: 'acc-me' }, issue: { key: 'BL-7' }, changelog: { items: [{ field: 'status', toString: 'In Progress' }] } }
    expect((await hook(moved, { token: 'nope' })).status).toBe(404)
    expect((await hook(moved, { sign: 'forged' })).status).toBe(401)
    expect(await (await hook(moved)).json()).toEqual({ ignored: 'moved to "In Progress"' })
    expect(await (await hook({ ...moved, user: { accountId: 'acc-x' }, changelog: { items: [{ field: 'status', toString: 'Selected for Development' }] } })).json())
      .toEqual({ ignored: 'moved by someone not on the approver list' })
  })
})
