import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { appConfig, oauthUrl } from '@/lib/github'
import { newState } from '@/lib/oauth-state'

export async function GET() {
  if (!(await appConfig())) return NextResponse.redirect(`${env.appUrl}/setup`)
  return NextResponse.redirect(await oauthUrl(await newState('bf_login')))
}
