import { requireAdmin } from '@/lib/session'
import { Nav } from './nav'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin()
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-4 md:flex-row md:p-6">
      <aside className="md:w-48 md:shrink-0">
        <div className="mb-4 px-3">
          <div className="text-sm font-semibold">basivo-factory</div>
          <div className="text-xs text-muted">{admin.login}</div>
        </div>
        <Nav />
        <form action="/api/auth/logout" method="post" className="mt-4 px-3">
          <button className="text-xs text-muted hover:text-fg">Sign out</button>
        </form>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}
