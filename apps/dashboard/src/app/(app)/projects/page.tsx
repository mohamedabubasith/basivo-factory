import Link from 'next/link'
import { ButtonLink, Empty, PageHeader } from '@/components/ui'
import { listProjects } from '@/lib/projects'

export default async function Projects() {
  const projects = await listProjects()
  return (
    <>
      <PageHeader title="Projects" sub="Each project links one Jira project to one repo." action={<ButtonLink href="/projects/new">Link a project</ButtonLink>} />
      {projects.length === 0 ? <Empty>No projects yet. Link a Jira project to a repo to start.</Empty> : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
          {projects.map(p => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-line/30">
                <span className="font-medium">{p.jiraProject} → {p.repo}</span>
                <span className="text-sm text-muted">starts at “{p.startStatus}” · runs on {p.runsOn}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
