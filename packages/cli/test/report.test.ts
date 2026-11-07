import { afterEach, describe, expect, it, vi } from 'vitest'
import { emit } from '../src/report.ts'

describe('emit', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('does nothing when no dashboard is configured', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('FACTORY_DASHBOARD_URL', '')
    await emit('BL-7', 'stage_started')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('posts the event with the run id and token', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('FACTORY_DASHBOARD_URL', 'https://dash.example/')
    vi.stubEnv('FACTORY_INGEST_TOKEN', 'tok')
    vi.stubEnv('GITHUB_RUN_ID', '42')
    vi.stubEnv('FACTORY_RUN', 'plan')
    await emit('BL-7', 'stage_started', { stage: 'plan' })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dash.example/api/ingest')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body))).toMatchObject({ ticket: 'BL-7', run: 'plan', ghRunId: 42, kind: 'stage_started', data: { stage: 'plan' } })
  })

  it('never throws when the dashboard is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    vi.stubEnv('FACTORY_DASHBOARD_URL', 'https://dash.example')
    vi.stubEnv('FACTORY_INGEST_TOKEN', 'tok')
    vi.stubEnv('GITHUB_RUN_ID', '42')
    await expect(emit('BL-7', 'x')).resolves.toBeUndefined()
  })
})
