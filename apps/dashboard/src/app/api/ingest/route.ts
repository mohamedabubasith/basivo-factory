import { JIRA_KEY } from '@basivo-factory/trackers'
import { z } from 'zod'
import { ingest, projectByIngestToken } from '@/lib/projects'

const Event = z.object({
  ticket: z.string().regex(JIRA_KEY),
  run: z.enum(['plan', 'build', 'all']),
  ghRunId: z.number().int().positive(),
  kind: z.string().regex(/^[a-z_]{1,40}$/),
  data: z.record(z.string(), z.unknown()),
  at: z.iso.datetime(),
})

// Progress from a runner. The bearer token was set as a repo secret when the project was linked; it identifies
// the project, so a runner can only write runs for its own project.
export async function POST(req: Request) {
  const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  const project = token ? await projectByIngestToken(token) : null
  if (!project) return new Response('unauthorized', { status: 401 })
  const raw = await req.text()
  if (raw.length > 64_000) return new Response('too large', { status: 413 })
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return new Response('bad json', { status: 400 })
  }
  const parsed = Event.safeParse(json)
  if (!parsed.success) return new Response('bad event', { status: 400 })
  if (!parsed.data.ticket.startsWith(`${project.jiraProject}-`)) return new Response('ticket not in this project', { status: 403 })
  await ingest(project, parsed.data)
  return new Response(null, { status: 202 })
}
