import { type NextRequest } from 'next/server'
import { safeEqual, sha256, verifyHubSignature } from '@/lib/crypto'
import { audit } from '@/lib/db'
import { dispatchRun, getProject, stopTicket, webhookSecretOf } from '@/lib/projects'
import { matchTrigger } from '@/lib/triggers'

// Jira calls this when a ticket in the linked project changes or gets a comment.
// Checked twice: the secret token in the URL, and Jira's signature when it sends one.
export async function POST(req: NextRequest, ctx: RouteContext<'/api/webhooks/jira/[id]'>) {
  const id = Number((await ctx.params).id)
  const project = Number.isInteger(id) ? await getProject(id) : null
  const token = req.nextUrl.searchParams.get('token') ?? ''
  if (!project?.webhookTokenHash || !safeEqual(sha256(token), project.webhookTokenHash)) return new Response('unknown webhook', { status: 404 })

  const body = await req.text()
  const signature = req.headers.get('x-hub-signature')
  const secret = webhookSecretOf(project)
  if (signature && secret && !verifyHubSignature(secret, body, signature)) return new Response('bad signature', { status: 401 })

  let event: unknown
  try {
    event = JSON.parse(body)
  } catch {
    return new Response('bad json', { status: 400 })
  }
  const t = matchTrigger(event as Parameters<typeof matchTrigger>[0], project)
  if ('ignored' in t) return Response.json({ ignored: t.ignored })

  const actor = `jira:${t.by}`
  if (t.action === 'stop') {
    const stopped = await stopTicket(project, t.ticket, actor)
    return Response.json({ stopped })
  }
  try {
    await dispatchRun(project, t.ticket, t.action, actor)
  } catch (e) {
    await audit(actor, 'run.dispatch_failed', { project: project.id, ticket: t.ticket, error: (e as Error).message })
    return new Response('could not start the run', { status: 502 })
  }
  return Response.json({ started: t.action, ticket: t.ticket })
}
