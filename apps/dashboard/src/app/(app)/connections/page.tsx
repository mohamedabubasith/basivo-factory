import { ActionForm } from '@/components/action-form'
import { Badge, Button, Card, Field, inputClass, PageHeader } from '@/components/ui'
import { connectionSummary } from '@/lib/connections'
import { listInstallations } from '@/lib/github'
import { disconnect, saveClaude, saveJira } from '../actions'

export default async function Connections() {
  const c = await connectionSummary()
  const gh = c.github_app?.config as { slug: string; owner: string; htmlUrl: string } | undefined
  const installs = gh ? await listInstallations().catch(() => []) : []
  const jira = c.jira?.config as { baseUrl: string; email: string; displayName: string } | undefined

  return (
    <>
      <PageHeader title="Connections" sub="Accounts the factory works with. Keys are stored encrypted and never shown again." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2">GitHub {gh ? <Badge kind="ok">connected</Badge> : <Badge kind="bad">not connected</Badge>}</span>}>
          {gh ? (
            <div className="space-y-3 text-sm">
              <p>App <a className="text-accent" href={gh.htmlUrl}>{gh.slug}</a>, owned by {gh.owner}.</p>
              <p className="text-muted">Installed on: {installs.length ? installs.map(i => `${i.account.login} (${i.repository_selection === 'all' ? 'all repos' : 'selected repos'})`).join(', ') : 'nothing yet'}</p>
              <a className="inline-flex h-9 items-center rounded-md border border-line px-3 font-medium hover:bg-line/50" href={`https://github.com/apps/${gh.slug}/installations/new`}>
                Choose repos
              </a>
            </div>
          ) : (
            <a className="text-accent" href="/api/github/start">Create the GitHub App</a>
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2">Jira {jira ? <Badge kind="ok">connected</Badge> : <Badge kind="bad">not connected</Badge>}</span>}
          footer={jira ? <form action={disconnect.bind(null, 'jira')}><Button variant="danger">Disconnect</Button></form> : undefined}>
          {jira ? <p className="mb-4 text-sm">{jira.baseUrl} as {jira.displayName} ({jira.email}).</p> : null}
          <ActionForm action={saveJira} submit={jira ? 'Replace' : 'Connect Jira'}>
            <Field label="Jira site"><input name="baseUrl" className={inputClass} placeholder="https://your-team.atlassian.net" defaultValue={jira?.baseUrl} required /></Field>
            <Field label="Email"><input name="email" type="email" className={inputClass} defaultValue={jira?.email} required /></Field>
            <Field label="API token" hint={<>Create one at <a className="text-accent" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">id.atlassian.com → Security → API tokens</a> (the plain kind, not “with scopes”).</>}>
              <input name="token" type="password" autoComplete="off" className={inputClass} required />
            </Field>
          </ActionForm>
        </Card>

        <Card title={<span className="flex items-center gap-2">Claude {c.claude ? <Badge kind="ok">saved</Badge> : <Badge kind="bad">missing</Badge>}</span>}
          footer={c.claude ? <form action={disconnect.bind(null, 'claude')}><Button variant="danger">Remove</Button></form> : undefined}>
          <ActionForm action={saveClaude} submit={c.claude ? 'Replace token' : 'Save token'}>
            <Field label="Claude token" hint={<>Run <code>claude setup-token</code> in a terminal and paste the result, or paste an Anthropic API key.</>}>
              <input name="token" type="password" autoComplete="off" className={inputClass} required />
            </Field>
          </ActionForm>
        </Card>

        <Card title={<span className="flex items-center gap-2">GitLab, YouTrack, Teams <Badge>later</Badge></span>}>
          <p className="text-sm text-muted">Coming next: the same Connect flow for the office GitLab, YouTrack and Teams approvals.</p>
        </Card>
      </div>
    </>
  )
}
