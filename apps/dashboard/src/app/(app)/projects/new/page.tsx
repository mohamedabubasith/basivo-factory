import { jiraAdmin } from '@basivo-factory/trackers'
import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { Card, Empty, Field, inputClass, PageHeader } from '@/components/ui'
import { getConnection } from '@/lib/connections'
import { installationRepos, listInstallations } from '@/lib/github'
import { RUNNER_CHOICES } from '@/lib/runners'
import { linkProject } from '../../actions'

export default async function NewProject({ searchParams }: PageProps<'/projects/new'>) {
  const [jiraConn, claude] = await Promise.all([getConnection('jira'), getConnection('claude')])
  const installs = await listInstallations().catch(() => [])
  if (!jiraConn || !claude || installs.length === 0) {
    return (
      <>
        <PageHeader title="Link a project" />
        <Empty>First connect GitHub (and choose repos), Jira and the Claude token on <Link className="text-accent" href="/connections">Connections</Link>.</Empty>
      </>
    )
  }
  const jira = jiraAdmin({ baseUrl: jiraConn.config.baseUrl, email: jiraConn.config.email, token: jiraConn.secret.token })
  const { jira: picked } = await searchParams
  const jiraProjects = await jira.projects()
  const chosen = typeof picked === 'string' && jiraProjects.some(p => p.key === picked) ? picked : null
  const statuses = chosen ? await jira.statuses(chosen) : []
  const repos = (await Promise.all(installs.map(async i => (await installationRepos(i.id)).map(r => ({ ...r, installationId: i.id }))))).flat()

  return (
    <>
      <PageHeader title="Link a project" sub="The dashboard adds the workflow, sets the secrets and variables, and asks Jira to notify it." />
      <div className="max-w-xl space-y-4">
        <Card title="1. Jira project">
          <form className="flex gap-2">
            <select name="jira" defaultValue={chosen ?? ''} className={inputClass} required>
              <option value="" disabled>Choose…</option>
              {jiraProjects.map(p => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
            </select>
            <button className="h-9 rounded-md border border-line px-3 text-sm">Next</button>
          </form>
        </Card>
        {chosen ? (
          <Card title="2. Repo and trigger">
            <ActionForm action={linkProject} submit="Link and set up">
              <input type="hidden" name="jiraProject" value={chosen} />
              <Field label="Repo" hint="Only repos the GitHub App is installed on are listed.">
                <select name="repo" className={inputClass} required>
                  {repos.map(r => <option key={r.full_name} value={`${r.installationId}|${r.full_name}`}>{r.full_name}{r.private ? ' (private)' : ''}</option>)}
                </select>
              </Field>
              <Field label="Start when a ticket moves to" hint="Moving a ticket into this column starts planning.">
                <select name="startStatus" className={inputClass} defaultValue={statuses.find(s => /selected/i.test(s)) ?? statuses[0]}>
                  {statuses.map(s => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Approve with the comment" hint="Replying exactly this on a ticket starts building its plan.">
                <input name="approveCommand" className={inputClass} defaultValue="/approve" />
              </Field>
              <Field label="Run jobs on">
                <select name="runsOn" className={inputClass} defaultValue="ubuntu-latest">
                  {RUNNER_CHOICES.map(r => <option key={r.label} value={r.label}>{r.name}</option>)}
                </select>
              </Field>
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  )
}
