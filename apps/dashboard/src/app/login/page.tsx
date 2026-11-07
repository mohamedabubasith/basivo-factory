import { redirect } from 'next/navigation'
import { appConfig } from '@/lib/github'
import { currentAdmin } from '@/lib/session'

const errors: Record<string, string> = {
  'not-allowed': 'That GitHub account is not allowed to use this dashboard.',
  expired: 'The sign-in link expired. Try again.',
}

export default async function Login({ searchParams }: PageProps<'/login'>) {
  if (await currentAdmin()) redirect('/runs')
  if (!(await appConfig())) redirect('/setup')
  const { error } = await searchParams
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-line bg-panel p-6 text-center">
        <h1 className="text-lg font-semibold">basivo-factory</h1>
        <p className="mt-1 text-sm text-muted">Agents that turn tickets into pull requests.</p>
        {typeof error === 'string' && errors[error] ? <p className="mt-4 rounded bg-bad/10 p-2 text-sm text-bad">{errors[error]}</p> : null}
        <a href="/api/auth/login" className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md bg-fg text-sm font-medium text-bg">
          Sign in with GitHub
        </a>
      </div>
    </main>
  )
}
