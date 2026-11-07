import 'server-only'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { signValue, verifyValue } from './crypto'
import { appKeys, env } from './env'

const COOKIE = 'bf_session'
const DAYS = 7

type Session = { login: string; exp: number }

export async function startSession(login: string) {
  const exp = Date.now() + DAYS * 86_400_000
  ;(await cookies()).set(COOKIE, signValue(appKeys().session, { login, exp } satisfies Session), {
    httpOnly: true, secure: env.appUrl.startsWith('https://'), sameSite: 'lax', path: '/', maxAge: DAYS * 86_400,
  })
}

export async function endSession() {
  ;(await cookies()).delete(COOKIE)
}

// The signed-in admin, or null. The allow-list is checked on every request, so removing a login from
// ADMIN_GITHUB_LOGINS locks it out at once.
export async function currentAdmin(): Promise<{ login: string } | null> {
  const raw = (await cookies()).get(COOKIE)?.value // first: reading the request makes the page per-request
  if (!raw) return null
  const s = verifyValue<Session>(appKeys().session, raw)
  if (!s || s.exp < Date.now() || !env.admins.includes(s.login.toLowerCase())) return null
  return { login: s.login }
}

// Every page and every Server Action calls this first: Server Actions are public endpoints.
export async function requireAdmin(): Promise<{ login: string }> {
  const admin = await currentAdmin()
  if (!admin) redirect('/login')
  return admin
}
