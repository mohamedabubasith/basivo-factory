import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { endSession } from '@/lib/session'

export async function POST() {
  await endSession()
  return NextResponse.redirect(`${env.appUrl}/login`, { status: 303 })
}
