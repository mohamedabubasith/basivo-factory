import 'server-only'
import { deriveKey } from './crypto'

// Three settings for the whole app; everything else (GitHub App, Jira, Claude token) is connected from the UI
// and stored encrypted in the database.
//   DATABASE_URL          Postgres (the self-hosted Supabase)
//   FACTORY_SECRET        long random string; encryption and session keys are derived from it
//   ADMIN_GITHUB_LOGINS   comma-separated GitHub logins allowed to sign in
// Optional: APP_URL (public address; on Vercel the production domain is used by default).
function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export const env = {
  get databaseUrl() { return need('DATABASE_URL') },
  get admins() { return need('ADMIN_GITHUB_LOGINS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean) },
  get appUrl() {
    const url = process.env.APP_URL
      ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000')
    return url.replace(/\/+$/, '')
  },
}

let keys: { secrets: Buffer; session: Buffer } | null = null
export function appKeys() {
  if (!keys) {
    const master = need('FACTORY_SECRET')
    if (master.length < 32) throw new Error('FACTORY_SECRET must be at least 32 characters')
    keys = { secrets: deriveKey(master, 'secrets'), session: deriveKey(master, 'session') }
  }
  return keys
}
