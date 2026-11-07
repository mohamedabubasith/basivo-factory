import { ActionForm } from '@/components/action-form'
import { Badge, Card, Empty, PageHeader } from '@/components/ui'
import { repoClient } from '@/lib/github'
import { listProjects } from '@/lib/projects'
import { RUNNER_CHOICES } from '@/lib/runners'
import { runnerCommand, saveProjectSettings } from '../actions'
import { ProjectPicker } from '../project-picker'

export default async function Runners({ searchParams }: PageProps<'/runners'>) {
  const projects = await listProjects()
  if (projects.length === 0) return (<><PageHeader title="Runners" /><Empty>Link a project first.</Empty></>)
  const { project: q } = await searchParams
  const p = projects.find(x => String(x.id) === q) ?? projects[0]!
  const machines = await repoClient(p.installationId, p.repo).runners().catch(() => [])

  return (
    <>
      <PageHeader title="Runners" sub="Where the agents' jobs run. Changing it takes effect on the next run."
        action={<ProjectPicker projects={projects.map(x => ({ id: x.id, name: x.name }))} current={p.id} path="/runners" />} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Run jobs on">
          <div className="space-y-3">
            {RUNNER_CHOICES.map(r => (
              <ActionForm key={r.label} action={saveProjectSettings.bind(null, p.id)} submit={p.runsOn === r.label ? 'In use' : 'Use this'}
                variant={p.runsOn === r.label ? 'ghost' : 'primary'} className="flex items-start justify-between gap-3 rounded-md border border-line p-3">
                <div className="text-sm">
                  <div className="font-medium">{r.name} {p.runsOn === r.label ? <Badge kind="ok">in use</Badge> : null}</div>
                  <div className="text-muted">{r.about}</div>
                </div>
                <input type="hidden" name="runsOn" value={r.label} />
                <input type="hidden" name="startStatus" value={p.startStatus} />
                <input type="hidden" name="approveCommand" value={p.approveCommand} />
                <input type="hidden" name="approvers" value={p.approvers.join('\n')} />
              </ActionForm>
            ))}
          </div>
        </Card>

        <Card title="Own machines">
          {machines.length === 0 ? <p className="mb-4 text-sm text-muted">No machines registered for {p.repo}.</p> : (
            <ul className="mb-4 space-y-2 text-sm">
              {machines.map(m => (
                <li key={m.id} className="flex items-center justify-between">
                  <span>{m.name} <span className="text-muted">({m.os}; {m.labels.map(l => l.name).join(', ')})</span></span>
                  <Badge kind={m.status === 'online' ? (m.busy ? 'info' : 'ok') : 'bad'}>{m.status === 'online' ? (m.busy ? 'busy' : 'online') : 'offline'}</Badge>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={runnerCommand.bind(null, p.id)} submit="Add a machine" variant="ghost" pre>
            <p className="text-sm text-muted">Shows the commands to run on a Linux server or VM (an instabox box works too). It then appears here as online.</p>
          </ActionForm>
        </Card>
      </div>
    </>
  )
}
