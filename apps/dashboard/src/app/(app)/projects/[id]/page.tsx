import { jiraAdmin } from '@basivo-factory/trackers'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { Button, Card, Checks, Field, inputClass, PageHeader } from '@/components/ui'
import { getConnection } from '@/lib/connections'
import { getProject, health } from '@/lib/projects'
import { RUNNER_CHOICES } from '@/lib/runners'
import { removeProject, repairProject, saveProjectSettings, startRun } from '../../actions'

export default async function ProjectPage({ params }: PageProps<'/projects/[id]'>) {
  const p = await getProject(Number((await params).id))
  if (!p) notFound()
  const j = await getConnection('jira')
  const [checks, statuses] = await Promise.all([
    health(p),
    j ? jiraAdmin({ baseUrl: j.config.baseUrl, email: j.config.email, token: j.secret.token }).statuses(p.jiraProject).catch(() => [p.startStatus]) : [p.startStatus],
  ])
  const runsOnKnown = RUNNER_CHOICES.some(r => r.label === p.runsOn)

  return (
    <>
      <PageHeader title={`${p.jiraProject} → ${p.repo}`}
        sub={<>Moving a ticket to <b>{p.startStatus}</b> starts planning; replying <b>{p.approveCommand}</b> starts building.</>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Health" footer={<ActionForm action={repairProject.bind(null, p.id)} submit="Repair" variant="ghost" className="space-y-3" />}>
          <Checks items={checks} />
          <p className="mt-3 text-xs text-muted">Repair re-adds anything missing and replaces the tokens and the Jira webhook.</p>
        </Card>

        <Card title="Start a run by hand">
          <ActionForm action={startRun.bind(null, p.id)} submit="Start">
            <Field label="Ticket"><input name="ticket" className={inputClass} placeholder={`${p.jiraProject}-7`} required /></Field>
            <Field label="Run">
              <select name="run" className={inputClass}><option value="plan">Plan</option><option value="build">Build (plan already approved)</option></select>
            </Field>
          </ActionForm>
        </Card>

        <Card title="Settings">
          <ActionForm action={saveProjectSettings.bind(null, p.id)} submit="Save">
            <Field label="Start when a ticket moves to">
              <select name="startStatus" className={inputClass} defaultValue={p.startStatus}>{statuses.map(s => <option key={s}>{s}</option>)}</select>
            </Field>
            <Field label="Approve with the comment"><input name="approveCommand" className={inputClass} defaultValue={p.approveCommand} /></Field>
            <Field label="Run jobs on" hint="Also set on the Runners page.">
              <select name="runsOn" className={inputClass} defaultValue={p.runsOn}>
                {RUNNER_CHOICES.map(r => <option key={r.label} value={r.label}>{r.name}</option>)}
                {runsOnKnown ? null : <option value={p.runsOn}>{p.runsOn}</option>}
              </select>
            </Field>
            <Field label="Who may start and approve" hint="Jira account ids, one per line. Moves and comments by anyone else are ignored.">
              <textarea name="approvers" rows={3} className={inputClass + ' h-auto py-2 font-mono text-xs'} defaultValue={p.approvers.join('\n')} />
            </Field>
          </ActionForm>
        </Card>

        <Card title="Unlink">
          <p className="mb-3 text-sm text-muted">Removes the Jira webhook and this project from the dashboard. The repo keeps its workflow file and secrets.</p>
          <form action={removeProject.bind(null, p.id)}><Button variant="danger">Unlink project</Button></form>
        </Card>
      </div>
    </>
  )
}
