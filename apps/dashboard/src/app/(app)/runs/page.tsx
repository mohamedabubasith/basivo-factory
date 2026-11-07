import { desc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { ago, Badge, Empty, money, PageHeader, statusBadge, tokens } from '@/components/ui'
import { db, projects, runs } from '@/lib/db'
import { AutoRefresh } from '../nav'

export default async function Runs() {
  const rows = await (await db())
    .select({ run: runs, repo: projects.repo })
    .from(runs).innerJoin(projects, eq(runs.projectId, projects.id))
    .orderBy(desc(runs.updatedAt)).limit(50)

  return (
    <>
      <AutoRefresh />
      <PageHeader title="Live runs" sub="Updates every few seconds. Cost and tokens are per ticket, across its runs." />
      {rows.length === 0 ? <Empty>No runs yet. Move a ticket to the start column, or start one from a project page.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr><th className="px-4 py-2">Ticket</th><th className="px-4 py-2">Run</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Now</th><th className="px-4 py-2 text-right">Tokens in/out</th><th className="px-4 py-2 text-right">Cost</th><th className="px-4 py-2">Updated</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map(({ run, repo }) => (
                <tr key={run.id} className="hover:bg-line/30">
                  <td className="px-4 py-2 font-medium"><Link href={`/runs/${run.id}`} className="hover:text-accent">{run.ticket}</Link><div className="text-xs text-muted">{repo}</div></td>
                  <td className="px-4 py-2">{run.kind}</td>
                  <td className="px-4 py-2"><Badge kind={statusBadge[run.status] ?? 'idle'}>{run.status}</Badge></td>
                  <td className="max-w-xs truncate px-4 py-2 text-muted">{run.prUrl ? <a className="text-accent" href={run.prUrl}>Pull request</a> : run.detail}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{tokens(run.inputTokens)} / {tokens(run.outputTokens)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(run.costUsd)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-muted">{ago(run.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
