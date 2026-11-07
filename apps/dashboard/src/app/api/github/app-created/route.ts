import { type NextRequest, NextResponse } from 'next/server'
import { saveConnection } from '@/lib/connections'
import { audit } from '@/lib/db'
import { env } from '@/lib/env'
import { convertManifest } from '@/lib/github'
import { checkState } from '@/lib/oauth-state'

// Manifest flow, step 2: GitHub created the App and sends a one-time code for its keys.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code || !(await checkState('bf_manifest', req.nextUrl.searchParams.get('state')))) {
    return new Response('This link expired or was not started here. Start again from the dashboard.', { status: 400 })
  }
  const app = await convertManifest(code)
  // Only an App owned by an allowed admin is kept; anyone else reaching this page cannot take over the dashboard.
  if (!env.admins.includes(app.owner.login.toLowerCase())) {
    return new Response(`The GitHub App was created by ${app.owner.login}, who is not in ADMIN_GITHUB_LOGINS. Delete it at ${app.html_url}/advanced.`, { status: 403 })
  }
  await saveConnection('github_app', {
    config: { appId: app.id, slug: app.slug, clientId: app.client_id, owner: app.owner.login, htmlUrl: app.html_url },
    secret: { pem: app.pem, clientSecret: app.client_secret, webhookSecret: app.webhook_secret },
  })
  await audit(app.owner.login, 'github.app_created', { slug: app.slug })
  // Next: install it on the repos the factory may work on.
  return NextResponse.redirect(`https://github.com/apps/${app.slug}/installations/new`)
}
