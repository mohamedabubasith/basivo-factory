import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'

export function PageHeader({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
      </div>
      {action}
    </div>
  )
}

export function Card({ title, children, footer }: { title?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      {title ? <h2 className="border-b border-line px-4 py-3 text-sm font-medium">{title}</h2> : null}
      <div className="p-4">{children}</div>
      {footer ? <div className="border-t border-line px-4 py-3">{footer}</div> : null}
    </section>
  )
}

const tone = {
  ok: 'bg-ok/15 text-ok', bad: 'bg-bad/15 text-bad', warn: 'bg-warn/15 text-warn', info: 'bg-accent/15 text-accent', idle: 'bg-line text-muted',
}
export function Badge({ kind = 'idle', children }: { kind?: keyof typeof tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${tone[kind]}`}>{children}</span>
}

export const statusBadge: Record<string, keyof typeof tone> = {
  running: 'info', waiting: 'warn', succeeded: 'ok', failed: 'bad', cancelled: 'idle',
}

export function Button({ variant = 'primary', className = '', ...rest }: ComponentProps<'button'> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const v = {
    primary: 'bg-accent text-white hover:opacity-90',
    ghost: 'border border-line hover:bg-line/50',
    danger: 'border border-bad/40 text-bad hover:bg-bad/10',
  }[variant]
  return <button className={`inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium disabled:opacity-50 ${v} ${className}`} {...rest} />
}

export function ButtonLink({ href, children, variant = 'primary' }: { href: string; children: ReactNode; variant?: 'primary' | 'ghost' }) {
  const v = variant === 'primary' ? 'bg-accent text-white hover:opacity-90' : 'border border-line hover:bg-line/50'
  return <Link href={href} className={`inline-flex h-9 items-center rounded-md px-3 text-sm font-medium ${v}`}>{children}</Link>
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  )
}

export const inputClass = 'h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent'
export const textareaClass = 'w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-accent'

export function Checks({ items }: { items: { step: string; ok: boolean; detail?: string }[] }) {
  return (
    <ul className="space-y-2 text-sm">
      {items.map(i => (
        <li key={i.step} className="flex items-start gap-2">
          <span className={i.ok ? 'text-ok' : 'text-bad'}>{i.ok ? '✓' : '✗'}</span>
          <span><span className="font-medium">{i.step}</span>{i.detail ? <span className="text-muted">: {i.detail}</span> : null}</span>
        </li>
      ))}
    </ul>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">{children}</p>
}

export const money = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `$${v.toFixed(2)}`)
export const tokens = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))
export function ago(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return d.toISOString().slice(0, 10)
}
