import { type NextRequest, NextResponse } from 'next/server'
import { audit } from '@/lib/db'
import { env } from '@/lib/env'
import { oauthUser } from '@/lib/github'
import { checkState } from '@/lib/oauth-state'
import { startSession } from '@/lib/session'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code || !(await checkState('bf_login', req.nextUrl.searchParams.get('state')))) {
    return NextResponse.redirect(`${env.appUrl}/login?error=expired`)
  }
  const login = await oauthUser(code)
  if (!env.admins.includes(login.toLowerCase())) {
    await audit(login, 'login.refused')
    return NextResponse.redirect(`${env.appUrl}/login?error=not-allowed`)
  }
  await startSession(login)
  await audit(login, 'login')
  return NextResponse.redirect(`${env.appUrl}/`)
}
