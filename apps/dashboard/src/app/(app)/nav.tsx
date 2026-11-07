'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect } from 'react'

const LINKS = [
  { href: '/runs', label: 'Live runs' },
  { href: '/projects', label: 'Projects' },
  { href: '/agents', label: 'Agents' },
  { href: '/runners', label: 'Runners' },
  { href: '/connections', label: 'Connections' },
]

export function Nav() {
  const path = usePathname()
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col">
      {LINKS.map(l => {
        const active = path === l.href || path.startsWith(`${l.href}/`)
        return (
          <Link key={l.href} href={l.href}
            className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${active ? 'bg-line font-medium text-fg' : 'text-muted hover:bg-line/50 hover:text-fg'}`}>
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}

// Reloads the server-rendered page on a timer while the tab is visible, so live runs update without a websocket.
export function AutoRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter()
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') router.refresh() }, seconds * 1000)
    return () => clearInterval(t)
  }, [router, seconds])
  return null
}
