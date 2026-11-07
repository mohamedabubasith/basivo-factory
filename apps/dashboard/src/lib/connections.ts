import 'server-only'
import { eq } from 'drizzle-orm'
import { decrypt, encrypt } from './crypto'
import { connections, db } from './db'
import { appKeys } from './env'

export type GitHubAppConfig = { appId: number; slug: string; clientId: string; owner: string; htmlUrl: string }
export type GitHubAppSecret = { pem: string; clientSecret: string; webhookSecret: string }
export type JiraConfig = { baseUrl: string; email: string; accountId: string; displayName: string }

type Kinds = {
  github_app: { config: GitHubAppConfig; secret: GitHubAppSecret }
  jira: { config: JiraConfig; secret: { token: string } }
  claude: { config: { kind: 'oauth' | 'api_key' }; secret: { token: string } }
}
export type Kind = keyof Kinds

export async function getConnection<K extends Kind>(kind: K): Promise<Kinds[K] | null> {
  const [row] = await (await db()).select().from(connections).where(eq(connections.kind, kind))
  if (!row?.secret) return null
  return { config: row.config, secret: JSON.parse(decrypt(appKeys().secrets, row.secret)) } as Kinds[K]
}

// Only what the UI may show: never the secret.
export async function connectionSummary() {
  const rows = await (await db()).select({ kind: connections.kind, config: connections.config, updatedAt: connections.updatedAt }).from(connections)
  return Object.fromEntries(rows.map(r => [r.kind, { config: r.config, updatedAt: r.updatedAt }])) as Partial<Record<Kind, { config: Record<string, unknown>; updatedAt: Date }>>
}

export async function saveConnection<K extends Kind>(kind: K, value: Kinds[K]) {
  const secret = encrypt(appKeys().secrets, JSON.stringify(value.secret))
  await (await db()).insert(connections).values({ kind, config: value.config, secret })
    .onConflictDoUpdate({ target: connections.kind, set: { config: value.config, secret, updatedAt: new Date() } })
}

export async function removeConnection(kind: Kind) {
  await (await db()).delete(connections).where(eq(connections.kind, kind))
}
