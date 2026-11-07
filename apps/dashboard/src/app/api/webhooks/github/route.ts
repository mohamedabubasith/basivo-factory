import { and, eq } from 'drizzle-orm'
import { verifyHubSignature } from '@/lib/crypto'
import { db, runs } from '@/lib/db'
import { webhookSecret } from '@/lib/github'

// GitHub App events. Used for one thing: a run that ends without telling us (cancelled, crashed, timed out)
// still gets its final status.
export async function POST(req: Request) {
  const secret = await webhookSecret()
  const body = await req.text()
  if (!secret || !verifyHubSignature(secret, body, req.headers.get('x-hub-signature-256'))) return new Response('bad signature', { status: 401 })
  if (req.headers.get('x-github-event') !== 'workflow_run') return new Response(null, { status: 204 })

  const e = JSON.parse(body) as { action: string; workflow_run: { id: number; conclusion: string | null } }
  if (e.action !== 'completed') return new Response(null, { status: 204 })
  const status = e.workflow_run.conclusion === 'cancelled' ? 'cancelled' : e.workflow_run.conclusion === 'success' ? null : 'failed'
  if (status) {
    await (await db()).update(runs)
      .set({ status, detail: status === 'cancelled' ? 'Stopped' : 'The workflow failed; see the GitHub run', updatedAt: new Date() })
      .where(and(eq(runs.ghRunId, e.workflow_run.id), eq(runs.status, 'running')))
  }
  return new Response(null, { status: 204 })
}
