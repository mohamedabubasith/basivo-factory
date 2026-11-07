import 'server-only'
import { createSign } from 'node:crypto'
import sodium from 'libsodium-wrappers'
import { getConnection, type GitHubAppConfig } from './connections'

const API = 'https://api.github.com'
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'basivo-factory-dashboard' }

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function call<T>(token: string | null, method: string, path: string, body?: unknown, ok: number[] = []): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: { ...HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok && !ok.includes(res.status)) throw new GitHubError(res.status, `GitHub ${method} ${path.replace(API, '')}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  if (res.status === 204 || res.status === 202 || ok.includes(res.status)) return null as T
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

// What the dashboard's GitHub App asks for. Created from this manifest in one click (GitHub's manifest flow).
export function appManifest(appUrl: string) {
  return {
    name: `basivo-factory-${Math.random().toString(36).slice(2, 7)}`,
    url: appUrl,
    hook_attributes: { url: `${appUrl}/api/webhooks/github`, active: true },
    redirect_url: `${appUrl}/api/github/app-created`,
    callback_urls: [`${appUrl}/api/auth/callback`],
    setup_url: `${appUrl}/connections`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: 'write', workflows: 'write', secrets: 'write', actions_variables: 'write', actions: 'write',
      administration: 'write', pull_requests: 'write', issues: 'write', metadata: 'read',
    },
    default_events: ['workflow_run'],
  }
}

// Manifest flow, step 2: GitHub hands back the new App's id, keys and secrets for a one-time code.
export async function convertManifest(code: string) {
  return call<{ id: number; slug: string; client_id: string; client_secret: string; webhook_secret: string; pem: string; html_url: string; owner: { login: string } }>(
    null, 'POST', `/app-manifests/${encodeURIComponent(code)}/conversions`)
}

async function app() {
  const c = await getConnection('github_app')
  if (!c) throw new Error('GitHub is not connected yet')
  return c
}

export async function appConfig(): Promise<GitHubAppConfig | null> {
  return (await getConnection('github_app'))?.config ?? null
}

// A 9-minute JWT signed with the App's private key: what GitHub requires to act as the App itself.
function appJwt(appId: number, pem: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(pem, 'base64url')}`
}

const tokens = new Map<number, { token: string; expires: number }>()

// An installation token (1 hour) acts on the repos the App was installed on; cached until 5 minutes before expiry.
export async function installationToken(installationId: number): Promise<string> {
  const hit = tokens.get(installationId)
  if (hit && hit.expires - Date.now() > 300_000) return hit.token
  const { config, secret } = await app()
  const r = await call<{ token: string; expires_at: string }>(appJwt(config.appId, secret.pem), 'POST', `/app/installations/${installationId}/access_tokens`)
  tokens.set(installationId, { token: r.token, expires: Date.parse(r.expires_at) })
  return r.token
}

export async function listInstallations() {
  const { config, secret } = await app()
  return call<{ id: number; account: { login: string }; repository_selection: string }[]>(appJwt(config.appId, secret.pem), 'GET', '/app/installations')
}

// Sign-in with GitHub through the same App (user-to-server OAuth).
export async function oauthUser(code: string): Promise<string> {
  const { config, secret } = await app()
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: secret.clientSecret, code }),
  })
  const { access_token: token } = await r.json() as { access_token?: string }
  if (!token) throw new Error('GitHub sign-in failed')
  return (await call<{ login: string }>(token, 'GET', '/user')).login
}

export async function oauthUrl(state: string): Promise<string> {
  const { config } = await app()
  return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(config.clientId)}&state=${encodeURIComponent(state)}`
}

export async function webhookSecret(): Promise<string | null> {
  return (await getConnection('github_app'))?.secret.webhookSecret ?? null
}

// Everything the dashboard does to one repo, with the installation's token.
export function repoClient(installationId: number, repo: string) {
  const r = (method: string, path: string, body?: unknown, ok?: number[]) =>
    installationToken(installationId).then(t => call<any>(t, method, `/repos/${repo}${path}`, body, ok)) // eslint-disable-line @typescript-eslint/no-explicit-any

  return {
    info: () => r('GET', '') as Promise<{ default_branch: string; html_url: string; private: boolean }>,

    async getFile(path: string): Promise<{ text: string; sha: string } | null> {
      const f = await r('GET', `/contents/${path}`, undefined, [404]) as { content: string; sha: string } | null
      return f ? { text: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.sha } : null
    },
    async putFile(path: string, text: string, message: string, sha?: string) {
      await r('PUT', `/contents/${path}`, { message, content: Buffer.from(text).toString('base64'), ...(sha ? { sha } : {}) })
    },
    async listDir(path: string): Promise<{ name: string; type: string }[]> {
      return (await r('GET', `/contents/${path}`, undefined, [404])) ?? []
    },

    // Secrets are encrypted in the dashboard with the repo's public key (libsodium sealed box): GitHub never
    // receives them in plain text, and they cannot be read back.
    async setSecret(name: string, value: string) {
      const { key, key_id } = await r('GET', '/actions/secrets/public-key') as { key: string; key_id: string }
      await sodium.ready
      const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key, sodium.base64_variants.ORIGINAL))
      await r('PUT', `/actions/secrets/${name}`, { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id })
    },
    async secretNames(): Promise<string[]> {
      return ((await r('GET', '/actions/secrets?per_page=100')) as { secrets: { name: string }[] }).secrets.map(s => s.name)
    },
    async setVariable(name: string, value: string) {
      const existing = await r('GET', `/actions/variables/${name}`, undefined, [404])
      if (existing) await r('PATCH', `/actions/variables/${name}`, { name, value })
      else await r('POST', '/actions/variables', { name, value })
    },
    async variables(): Promise<Record<string, string>> {
      const { variables } = await r('GET', '/actions/variables?per_page=100') as { variables: { name: string; value: string }[] }
      return Object.fromEntries(variables.map(v => [v.name, v.value]))
    },

    async dispatch(ref: string, inputs: Record<string, string>) {
      await r('POST', '/actions/workflows/factory.yml/dispatches', { ref, inputs })
    },
    async cancelRun(runId: number) {
      await r('POST', `/actions/runs/${runId}/cancel`, undefined, [409])
    },

    async runners(): Promise<{ id: number; name: string; os: string; status: string; busy: boolean; labels: { name: string }[] }[]> {
      return ((await r('GET', '/actions/runners?per_page=100')) as { runners: never[] }).runners
    },
    async runnerRegistrationToken(): Promise<string> {
      return ((await r('POST', '/actions/runners/registration-token')) as { token: string }).token
    },
  }
}

export async function installationRepos(installationId: number) {
  const t = await installationToken(installationId)
  const { repositories } = await call<{ repositories: { full_name: string; private: boolean; default_branch: string }[] }>(t, 'GET', '/installation/repositories?per_page=100')
  return repositories
}
