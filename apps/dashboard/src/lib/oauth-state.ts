import 'server-only'
import { cookies } from 'next/headers'
import { randomToken, safeEqual } from './crypto'
import { env } from './env'

// A one-time value in a short-lived cookie, echoed back by GitHub: proves the redirect is the one we started.
export async function newState(name: string): Promise<string> {
  const state = randomToken(24)
  ;(await cookies()).set(name, state, { httpOnly: true, secure: env.appUrl.startsWith('https://'), sameSite: 'lax', path: '/', maxAge: 600 })
  return state
}

export async function checkState(name: string, got: string | null): Promise<boolean> {
  const jar = await cookies()
  const want = jar.get(name)?.value
  jar.delete(name)
  return Boolean(want && got && safeEqual(want, got))
}
