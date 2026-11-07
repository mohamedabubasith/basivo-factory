'use client'

import { useActionState, type ReactNode } from 'react'
import type { ActionResult } from '@/app/(app)/actions'
import { Button, Checks } from './ui'

// A form bound to a Server Action that returns { ok, message, steps }: shows the outcome under the button.
export function ActionForm({
  action, submit, children, variant = 'primary', pre = false, className = 'space-y-4',
}: {
  action: (state: ActionResult, f: FormData) => Promise<ActionResult>
  submit: string
  children?: ReactNode
  variant?: 'primary' | 'ghost' | 'danger'
  pre?: boolean // show the message as a code block (commands)
  className?: string
}) {
  const [state, run, pending] = useActionState(action, null)
  return (
    <form action={run} className={className}>
      {children}
      <Button variant={variant} disabled={pending}>{pending ? 'Working…' : submit}</Button>
      {state?.steps ? <Checks items={state.steps} /> : null}
      {state?.message ? (
        pre && state.ok
          ? <pre className="overflow-x-auto rounded-md bg-bg p-3 text-xs">{state.message}</pre>
          : <p className={`text-sm ${state.ok ? 'text-ok' : 'text-bad'}`}>{state.message}</p>
      ) : null}
    </form>
  )
}
