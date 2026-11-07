import { appConfig, appManifest } from '@/lib/github'
import { env } from '@/lib/env'
import { newState } from '@/lib/oauth-state'
import { currentAdmin } from '@/lib/session'

// Manifest flow, step 1: a self-submitting form that sends the App definition to GitHub. Allowed before anyone
// can sign in (there is no App to sign in with yet); step 2 only saves an App owned by an allowed admin.
export async function GET() {
  if ((await appConfig()) && !(await currentAdmin())) return new Response('GitHub is already connected', { status: 403 })
  const state = await newState('bf_manifest')
  const manifest = JSON.stringify(appManifest(env.appUrl)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const html = `<!doctype html><meta charset="utf-8"><title>Creating GitHub App…</title>
<form id="f" method="post" action="https://github.com/settings/apps/new?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${manifest}"><noscript><button>Continue to GitHub</button></noscript></form>
<script>document.getElementById('f').submit()</script>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
