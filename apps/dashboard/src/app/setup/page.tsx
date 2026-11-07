import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { env } from '@/lib/env'
import { appConfig } from '@/lib/github'

// First run only: there is no GitHub App yet, so nobody can sign in. One click creates the App on GitHub.
export default async function Setup() {
  await connection() // per request: whether the App exists changes after setup
  if (await appConfig()) redirect('/login')
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold">Set up basivo-factory</h1>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
          <li><b>Create the GitHub App.</b> GitHub shows what it may access; click <i>Create GitHub App</i> there.</li>
          <li><b>Install it</b> on the repos the agents may work on (GitHub asks right after).</li>
          <li><b>Sign in</b> with your GitHub account ({env.admins.join(', ')}).</li>
        </ol>
        <p className="mt-4 text-xs text-muted">
          The App can read and write code, pull requests, workflows, secrets and variables of the repos you install it on.
          Its keys are stored encrypted in this dashboard&apos;s database.
        </p>
        <a href="/api/github/start" className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md bg-fg text-sm font-medium text-bg">
          Create GitHub App
        </a>
      </div>
    </main>
  )
}
