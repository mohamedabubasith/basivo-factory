import { asc, eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { Badge, Button, Card, money, PageHeader, statusBadge, tokens } from '@/components/ui'
import { db, runEvents, runs } from '@/lib/db'
import { getProject } from '@/lib/projects'
import { approveRun, stopRun } from '../../actions'
import { AutoRefresh } from '../../nav'

// One line per event, in plain words.
function describe(kind: string, d: Record<string, unknown>): string {
  switch (kind) {
    case 'stage_started': return `${d.stage} started`
    case 'stage_finished': return `${d.stage} finished`
    case 'stage_failed': return `${d.stage} failed: ${d.error}`
    case 'plan_posted': return `Plan posted: ${Array.isArray(d.steps) ? d.steps.length : '?'} steps`
    case 'attempt': return `Step ${d.step}/${d.of}, try ${d.attempt}: ${d.result}${d.failureReason ? ` (${String(d.failureReason).slice(0, 160)})` : ''}${d.honest === false ? ' · claimed changes did not match the diff' : ''}`
    case 'review': return `Review: ${d.verdict}, ${d.findings} findings`
    case 'pr_opened': return `Pull request #${d.number} opened`
    default: return kind
  }
}

export default async function RunPage({ params }: PageProps<'/runs/[id]'>) {
  const id = Number((await params).id)
  const d = await db()
  const [run] = await d.select().from(runs).where(eq(runs.id, id))
  if (!run) notFound()
  const project = await getProject(run.projectId)
  const events = await d.select().from(runEvents).where(eq(runEvents.runId, id)).orderBy(asc(runEvents.id))
  const plan = events.find(e => e.kind === 'plan_posted')?.data as { summary?: string; steps?: { task: string; doneWhen: string }[] } | undefined

  return (
    <>
      {run.status === 'running' ? <AutoRefresh /> : null}
      <PageHeader title={`${run.ticket} · ${run.kind}`}
        sub={<><Badge kind={statusBadge[run.status] ?? 'idle'}>{run.status}</Badge> <span className="ml-2">{run.detail}</span></>}
        action={
          <div className="flex gap-2">
            {run.status === 'waiting' && run.kind !== 'build' ? <form action={approveRun.bind(null, run.id)}><Button>Approve plan</Button></form> : null}
            {run.status === 'running' ? <form action={stopRun.bind(null, run.id)}><Button variant="danger">Stop</Button></form> : null}
          </div>
        } />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {plan?.steps ? (
            <Card title="Plan">
              {plan.summary ? <p className="mb-3 text-sm">{plan.summary}</p> : null}
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                {plan.steps.map((s, i) => <li key={i}>{s.task}<div className="font-mono text-xs text-muted">done when: {s.doneWhen}</div></li>)}
              </ol>
            </Card>
          ) : null}
          <Card title="Timeline">
            <ol className="space-y-2 text-sm">
              {events.map(e => (
                <li key={e.id} className="flex gap-3">
                  <span className="w-16 shrink-0 tabular-nums text-muted">{e.at.toISOString().slice(11, 19)}</span>
                  <span>{describe(e.kind, e.data)}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <Card title="Numbers">
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted">Cost (ticket)</dt><dd className="text-right tabular-nums">{money(run.costUsd)}</dd>
            <dt className="text-muted">Tokens in</dt><dd className="text-right tabular-nums">{tokens(run.inputTokens)}</dd>
            <dt className="text-muted">Tokens out</dt><dd className="text-right tabular-nums">{tokens(run.outputTokens)}</dd>
          </dl>
          <div className="mt-4 space-y-1 text-sm">
            {run.prUrl ? <a className="block text-accent" href={run.prUrl}>Pull request</a> : null}
            {project ? <a className="block text-accent" href={`https://github.com/${project.repo}/actions/runs/${run.ghRunId}`}>GitHub run and logs</a> : null}
          </div>
        </Card>
      </div>
    </>
  )
}
