import 'server-only'
import { jiraAdmin } from '@basivo-factory/trackers'
import { and, desc, eq } from 'drizzle-orm'
import { decrypt, encrypt, randomToken, sha256 } from './crypto'
import { getConnection } from './connections'
import { audit, db, projects, runEvents, runs } from './db'
import { appKeys, env } from './env'
import { repoClient } from './github'
import { FACTORY_WORKFLOW, FACTORY_WORKFLOW_PATH } from './templates'

export type Project = typeof projects.$inferSelect
export type Step = { step: string; ok: boolean; detail?: string }

const REQUIRED_SECRETS = ['CLAUDE_CODE_OAUTH_TOKEN', 'JIRA_API_TOKEN', 'FACTORY_INGEST_TOKEN'] as const

async function jira() {
  const c = await getConnection('jira')
  if (!c) throw new Error('Connect Jira first')
  return { conn: c, api: jiraAdmin({ baseUrl: c.config.baseUrl, email: c.config.email, token: c.secret.token }) }
}

export async function listProjects() {
  return (await db()).select().from(projects).orderBy(projects.name)
}

export async function getProject(id: number) {
  const [p] = await (await db()).select().from(projects).where(eq(projects.id, id))
  return p ?? null
}

export type LinkInput = {
  jiraProject: string; repo: string; installationId: number; startStatus: string; approveCommand: string; runsOn: string
}

// Sets a repo up to be driven from one Jira project. Safe to run again ("Repair"): files are only added when
// missing, and the tokens and webhook are replaced with fresh ones.
export async function setUpProject(input: LinkInput, actor: string, existingId?: number): Promise<{ id: number | null; steps: Step[] }> {
  const steps: Step[] = []
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      steps.push({ step: name, ok: true, detail: (await fn()) ?? undefined })
      return true
    } catch (e) {
      steps.push({ step: name, ok: false, detail: (e as Error).message })
      return false
    }
  }

  const claude = await getConnection('claude')
  if (!claude) return { id: null, steps: [{ step: 'Claude token', ok: false, detail: 'Add the Claude token on the Connections page first' }] }
  const { conn, api } = await jira()
  const gh = repoClient(input.installationId, input.repo)
  const ingestToken = randomToken()
  const webhookToken = randomToken()
  const webhookSecret = randomToken()

  const old = existingId ? await getProject(existingId) : null
  const [row] = old
    ? await (await db()).update(projects).set({ ...input, name: `${input.jiraProject} → ${input.repo}` }).where(eq(projects.id, old.id)).returning()
    : await (await db()).insert(projects).values({ ...input, name: `${input.jiraProject} → ${input.repo}`, approvers: [conn.config.accountId] }).returning()
  const id = row!.id

  await step('Workflow file', async () => {
    const f = await gh.getFile(FACTORY_WORKFLOW_PATH)
    if (f?.text === FACTORY_WORKFLOW) return 'already up to date'
    await gh.putFile(FACTORY_WORKFLOW_PATH, FACTORY_WORKFLOW, 'Add the basivo-factory workflow', f?.sha)
    return f ? 'updated' : 'added'
  })
  await step('Secrets', async () => {
    await gh.setSecret('CLAUDE_CODE_OAUTH_TOKEN', claude.secret.token)
    await gh.setSecret('JIRA_API_TOKEN', conn.secret.token)
    await gh.setSecret('FACTORY_INGEST_TOKEN', ingestToken)
    return REQUIRED_SECRETS.join(', ')
  })
  await step('Variables', async () => {
    const vars = { JIRA_BASE_URL: conn.config.baseUrl, JIRA_EMAIL: conn.config.email, FACTORY_DASHBOARD_URL: env.appUrl, FACTORY_RUNS_ON: input.runsOn }
    for (const [k, v] of Object.entries(vars)) await gh.setVariable(k, v)
    return Object.keys(vars).join(', ')
  })
  await step('Jira webhook', async () => {
    if (old?.webhookId) await api.deleteWebhook(old.webhookId)
    const webhookId = await api.createWebhook({
      name: `basivo-factory: ${input.jiraProject} → ${input.repo}`,
      url: `${env.appUrl}/api/webhooks/jira/${id}?token=${webhookToken}`,
      projectKey: input.jiraProject,
      secret: webhookSecret,
    })
    await (await db()).update(projects).set({
      webhookId, webhookTokenHash: sha256(webhookToken), webhookSecret: encrypt(appKeys().secrets, webhookSecret),
    }).where(eq(projects.id, id))
    return `id ${webhookId}`
  })
  // The ingest token is saved only if the repo got it; otherwise the old one keeps working.
  if (steps.find(s => s.step === 'Secrets')?.ok) {
    await (await db()).update(projects).set({ ingestTokenHash: sha256(ingestToken) }).where(eq(projects.id, id))
  }
  await audit(actor, old ? 'project.repaired' : 'project.linked', { id, repo: input.repo, jira: input.jiraProject, steps })
  return { id, steps }
}

export async function unlinkProject(id: number, actor: string) {
  const p = await getProject(id)
  if (!p) return
  if (p.webhookId) await (await jira()).api.deleteWebhook(p.webhookId).catch(() => undefined)
  await (await db()).delete(projects).where(eq(projects.id, id))
  await audit(actor, 'project.unlinked', { id, repo: p.repo })
}

export async function updateProjectSettings(id: number, set: Partial<Pick<Project, 'startStatus' | 'approveCommand' | 'runsOn' | 'approvers'>>, actor: string) {
  const p = await getProject(id)
  if (!p) throw new Error('project not found')
  if (set.runsOn && set.runsOn !== p.runsOn) await repoClient(p.installationId, p.repo).setVariable('FACTORY_RUNS_ON', set.runsOn)
  await (await db()).update(projects).set(set).where(eq(projects.id, id))
  await audit(actor, 'project.updated', { id, ...set })
}

// What a person checks when something does not start: is everything the pipeline needs in place?
export async function health(p: Project): Promise<Step[]> {
  const gh = repoClient(p.installationId, p.repo)
  const checks: Step[] = []
  const check = async (step: string, fn: () => Promise<[boolean, string?]>) => {
    try {
      const [ok, detail] = await fn()
      checks.push({ step, ok, detail })
    } catch (e) {
      checks.push({ step, ok: false, detail: (e as Error).message })
    }
  }
  await check('Workflow file', async () => {
    const f = await gh.getFile(FACTORY_WORKFLOW_PATH)
    return f ? [true, f.text === FACTORY_WORKFLOW ? 'up to date' : 'present (differs from the template)'] : [false, 'missing']
  })
  await check('Secrets', async () => {
    const names = await gh.secretNames()
    const missing = REQUIRED_SECRETS.filter(n => !names.includes(n))
    return [missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'all set']
  })
  await check('Variables', async () => {
    const v = await gh.variables()
    const missing = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'FACTORY_DASHBOARD_URL'].filter(n => !v[n])
    return [missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `runs on ${v.FACTORY_RUNS_ON ?? 'ubuntu-latest'}`]
  })
  await check('Jira webhook', async () => {
    if (!p.webhookId) return [false, 'not registered']
    return (await (await jira()).api.webhookExists(p.webhookId)) ? [true, `id ${p.webhookId}`] : [false, 'deleted in Jira; run Repair']
  })
  return checks
}

export async function dispatchRun(p: Project, ticket: string, run: 'plan' | 'build', actor: string) {
  const gh = repoClient(p.installationId, p.repo)
  const { default_branch: ref } = await gh.info()
  await gh.dispatch(ref, { ticket, run })
  await audit(actor, `run.${run}`, { project: p.id, ticket })
}

export async function stopTicket(p: Project, ticket: string, actor: string) {
  const d = await db()
  const active = await d.select().from(runs)
    .where(and(eq(runs.projectId, p.id), eq(runs.ticket, ticket), eq(runs.status, 'running')))
    .orderBy(desc(runs.startedAt))
  for (const r of active) await repoClient(p.installationId, p.repo).cancelRun(r.ghRunId)
  await audit(actor, 'run.stop', { project: p.id, ticket, runs: active.map(r => r.ghRunId) })
  return active.length
}

export async function projectByIngestToken(token: string) {
  const [p] = await (await db()).select().from(projects).where(eq(projects.ingestTokenHash, sha256(token)))
  return p ?? null
}

export const webhookSecretOf = (p: Project) => (p.webhookSecret ? decrypt(appKeys().secrets, p.webhookSecret) : null)

// --- live progress from the runner ---

export type IngestEvent = { ticket: string; run: string; ghRunId: number; kind: string; data: Record<string, unknown>; at: string }
type UsageRow = { costUsd: number | null; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }

// How each event changes the run's one-line status. Pure, so the mapping is tested.
export function runUpdate(e: IngestEvent): Partial<typeof runs.$inferInsert> {
  const d = e.data
  const usage = Array.isArray(d.usage) ? (d.usage as UsageRow[]) : null
  const totals = usage ? {
    costUsd: usage.reduce((t, r) => t + (r.costUsd ?? 0), 0),
    inputTokens: usage.reduce((t, r) => t + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0),
    outputTokens: usage.reduce((t, r) => t + r.outputTokens, 0),
  } : {}
  switch (e.kind) {
    case 'stage_started': return { status: 'running', stage: String(d.stage), detail: `${String(d.stage)} started` }
    case 'stage_finished':
      if (d.stage === 'plan') return { ...totals, status: 'waiting', stage: 'plan', detail: 'Plan posted, waiting for approval' }
      if (d.stage === 'ship') return { ...totals, status: 'succeeded', stage: 'ship', detail: 'Pull request opened' }
      return { ...totals, stage: String(d.stage), detail: `${String(d.stage)} finished` }
    case 'stage_failed': return { ...totals, status: 'failed', stage: String(d.stage), detail: String(d.error ?? 'failed') }
    case 'plan_posted': return { detail: `Plan: ${Array.isArray(d.steps) ? d.steps.length : '?'} steps` }
    case 'attempt': return { detail: `Step ${d.step}/${d.of}, try ${d.attempt}: ${d.result}` }
    case 'review': return { detail: `Review: ${String(d.verdict)}` }
    case 'pr_opened': return { prUrl: String(d.url) }
    default: return {}
  }
}

export async function ingest(p: Project, e: IngestEvent) {
  const d = await db()
  const update = runUpdate(e)
  const [run] = await d.insert(runs)
    .values({ projectId: p.id, ticket: e.ticket, kind: e.run, ghRunId: e.ghRunId, status: 'running', ...update })
    .onConflictDoUpdate({ target: runs.ghRunId, set: { ...update, updatedAt: new Date() } })
    .returning({ id: runs.id, projectId: runs.projectId })
  if (run!.projectId !== p.id) throw new Error('run belongs to another project')
  const { usage: _, ...data } = e.data
  await d.insert(runEvents).values({ runId: run!.id, kind: e.kind, data, at: new Date(e.at) })
}
