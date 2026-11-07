'use server'

import { formatProfileDoc, parseProfileDoc, ProfileSettings } from '@basivo-factory/core'
import { jira as jiraTracker, jiraAdmin, JIRA_KEY } from '@basivo-factory/trackers'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getConnection, removeConnection, saveConnection, type Kind } from '@/lib/connections'
import { audit, db, runs } from '@/lib/db'
import { repoClient } from '@/lib/github'
import {
  dispatchRun, getProject, setUpProject, stopTicket, unlinkProject, updateProjectSettings, type Step,
} from '@/lib/projects'
import { requireAdmin } from '@/lib/session'

export type ActionResult = { ok: boolean; message?: string; steps?: Step[] } | null

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

// --- Connections ---

export async function saveJira(_: ActionResult, f: FormData): Promise<ActionResult> {
  const admin = await requireAdmin()
  const baseUrl = str(f, 'baseUrl').replace(/\/+$/, '')
  const email = str(f, 'email')
  const token = str(f, 'token')
  if (!baseUrl || !email || !token) return { ok: false, message: 'Fill in all three fields.' }
  try {
    const me = await jiraAdmin({ baseUrl, email, token }).myself()
    await saveConnection('jira', { config: { baseUrl, email, accountId: me.accountId, displayName: me.displayName }, secret: { token } })
    await audit(admin.login, 'jira.connected', { baseUrl, email })
    revalidatePath('/connections')
    return { ok: true, message: `Connected as ${me.displayName}.` }
  } catch (e) {
    return { ok: false, message: `Jira did not accept these details: ${(e as Error).message}` }
  }
}

export async function saveClaude(_: ActionResult, f: FormData): Promise<ActionResult> {
  const admin = await requireAdmin()
  const token = str(f, 'token')
  if (!/^sk-ant-[a-z0-9]+-/i.test(token)) return { ok: false, message: 'That does not look like a Claude token (it starts with sk-ant-).' }
  await saveConnection('claude', { config: { kind: token.startsWith('sk-ant-oat') ? 'oauth' : 'api_key' }, secret: { token } })
  await audit(admin.login, 'claude.saved')
  revalidatePath('/connections')
  return { ok: true, message: 'Saved. Linked projects get it the next time you press Repair.' }
}

export async function disconnect(kind: Kind) {
  const admin = await requireAdmin()
  await removeConnection(kind)
  await audit(admin.login, `${kind}.disconnected`)
  revalidatePath('/connections')
}

// --- Projects ---

function linkInput(f: FormData) {
  const [installationId, repo] = str(f, 'repo').split('|')
  return {
    jiraProject: str(f, 'jiraProject'),
    repo: repo ?? '',
    installationId: Number(installationId),
    startStatus: str(f, 'startStatus'),
    approveCommand: str(f, 'approveCommand') || '/approve',
    runsOn: str(f, 'runsOn') || 'ubuntu-latest',
  }
}

export async function linkProject(_: ActionResult, f: FormData): Promise<ActionResult> {
  const admin = await requireAdmin()
  const input = linkInput(f)
  if (!/^[A-Z][A-Z0-9_]+$/.test(input.jiraProject) || !/^[\w.-]+\/[\w.-]+$/.test(input.repo) || !input.installationId || !input.startStatus) {
    return { ok: false, message: 'Choose a Jira project, a start column and a repo.' }
  }
  const { id, steps } = await setUpProject(input, admin.login)
  if (id && steps.every(s => s.ok)) redirect(`/projects/${id}`)
  return { ok: false, steps, message: id ? 'Linked, but some steps failed. Fix them and press Repair on the project page.' : undefined }
}

export async function repairProject(id: number, _: ActionResult): Promise<ActionResult> {
  const admin = await requireAdmin()
  const p = await getProject(id)
  if (!p) return { ok: false, message: 'Project not found.' }
  const { steps } = await setUpProject(
    { jiraProject: p.jiraProject, repo: p.repo, installationId: p.installationId, startStatus: p.startStatus, approveCommand: p.approveCommand, runsOn: p.runsOn },
    admin.login, p.id)
  revalidatePath(`/projects/${id}`)
  return { ok: steps.every(s => s.ok), steps }
}

export async function saveProjectSettings(id: number, _: ActionResult, f: FormData): Promise<ActionResult> {
  const admin = await requireAdmin()
  const approvers = str(f, 'approvers').split(/[\s,]+/).filter(Boolean)
  if (approvers.length === 0) return { ok: false, message: 'Keep at least one approver.' }
  await updateProjectSettings(id, {
    startStatus: str(f, 'startStatus'), approveCommand: str(f, 'approveCommand') || '/approve', runsOn: str(f, 'runsOn') || 'ubuntu-latest', approvers,
  }, admin.login)
  revalidatePath(`/projects/${id}`)
  return { ok: true, message: 'Saved.' }
}

export async function removeProject(id: number) {
  const admin = await requireAdmin()
  await unlinkProject(id, admin.login)
  redirect('/projects')
}

export async function startRun(id: number, _: ActionResult, f: FormData): Promise<ActionResult> {
  const admin = await requireAdmin()
  const p = await getProject(id)
  const ticket = str(f, 'ticket').toUpperCase()
  const run = str(f, 'run') === 'build' ? 'build' : 'plan'
  if (!p) return { ok: false, message: 'Project not found.' }
  if (!JIRA_KEY.test(ticket) || !ticket.startsWith(`${p.jiraProject}-`)) return { ok: false, message: `Enter a ${p.jiraProject} ticket, for example ${p.jiraProject}-7.` }
  try {
    await dispatchRun(p, ticket, run, admin.login)
    return { ok: true, message: `Started ${run} for ${ticket}. It appears under Live runs in a few seconds.` }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

// --- Runs ---

async function runAndProject(runId: number) {
  const [run] = await (await db()).select().from(runs).where(eq(runs.id, runId))
  const project = run ? await getProject(run.projectId) : null
  if (!run || !project) throw new Error('run not found')
  return { run, project }
}

// Same as replying /approve on the ticket; the comment keeps the ticket's history complete.
export async function approveRun(runId: number) {
  const admin = await requireAdmin()
  const { run, project } = await runAndProject(runId)
  await dispatchRun(project, run.ticket, 'build', admin.login)
  const j = await getConnection('jira')
  if (j) await jiraTracker({ baseUrl: j.config.baseUrl, email: j.config.email, token: j.secret.token })
    .comment(run.ticket, `Plan approved by ${admin.login} in the basivo-factory dashboard. Building now.`).catch(() => undefined)
  await (await db()).update(runs).set({ status: 'succeeded', detail: 'Plan approved', updatedAt: new Date() }).where(eq(runs.id, runId))
  revalidatePath('/runs')
}

export async function stopRun(runId: number) {
  const admin = await requireAdmin()
  const { run, project } = await runAndProject(runId)
  await stopTicket(project, run.ticket, admin.login)
  revalidatePath(`/runs/${runId}`)
}

// --- Agents ---

const STARS = { polaris: 'Polaris', sirius: 'Sirius', vega: 'Vega' } as const

export async function saveAgent(projectId: number, star: keyof typeof STARS, _: ActionResult, f: FormData): Promise<ActionResult> {
  const admin = await requireAdmin()
  const p = await getProject(projectId)
  if (!p || !(star in STARS)) return { ok: false, message: 'Not found.' }
  const list = (k: string) => str(f, k).split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
  const num = (k: string) => (str(f, k) ? Number(str(f, k)) : undefined)
  const parsed = ProfileSettings.safeParse({
    runtime: str(f, 'runtime'), model: str(f, 'model') || undefined, skills: f.getAll('skills').map(String), mcp: f.getAll('mcp').map(String),
    knowledge: list('knowledge'), maxTurns: num('maxTurns'), maxBudgetUsd: num('maxBudgetUsd'),
  })
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
  let text: string
  try {
    text = formatProfileDoc({ settings: parsed.data, instructions: String(f.get('instructions') ?? '') })
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
  const path = `.factory/agents/${star}.md`
  const gh = repoClient(p.installationId, p.repo)
  const current = await gh.getFile(path)
  if (current?.text === text) return { ok: true, message: 'No changes.' }
  await gh.putFile(path, text, `Update ${STARS[star]} settings from the basivo-factory dashboard`, current?.sha)
  await audit(admin.login, 'agent.saved', { project: p.id, star })
  revalidatePath('/agents')
  return { ok: true, message: `Saved to ${p.repo}/${path}. The next run uses it.` }
}

// Checked again on save; exported for the page to show the current file.
export async function readAgent(projectId: number, star: keyof typeof STARS) {
  await requireAdmin()
  const p = await getProject(projectId)
  if (!p) return null
  const f = await repoClient(p.installationId, p.repo).getFile(`.factory/agents/${star}.md`)
  return f ? parseProfileDoc(f.text) : null
}

// --- Runners ---

export async function runnerCommand(projectId: number, _: ActionResult): Promise<ActionResult> {
  const admin = await requireAdmin()
  const p = await getProject(projectId)
  if (!p) return { ok: false, message: 'Project not found.' }
  const token = await repoClient(p.installationId, p.repo).runnerRegistrationToken()
  const rel = await fetch('https://api.github.com/repos/actions/runner/releases/latest', { headers: { accept: 'application/vnd.github+json' } }).then(r => r.json()) as { tag_name: string }
  const v = rel.tag_name.replace(/^v/, '')
  await audit(admin.login, 'runner.token', { project: p.id })
  return {
    ok: true,
    message: [
      '# On the machine (Linux x64). The token works once, for 1 hour.',
      'mkdir -p ~/actions-runner && cd ~/actions-runner',
      `curl -fsSLo runner.tgz https://github.com/actions/runner/releases/download/v${v}/actions-runner-linux-x64-${v}.tar.gz`,
      'tar xzf runner.tgz',
      `./config.sh --unattended --url https://github.com/${p.repo} --token ${token} --labels factory --name "$(hostname)"`,
      'sudo ./svc.sh install && sudo ./svc.sh start   # keeps it running after reboot',
    ].join('\n'),
  }
}
