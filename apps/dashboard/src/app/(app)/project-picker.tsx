'use client'

import { useRouter } from 'next/navigation'
import { inputClass } from '@/components/ui'

export function ProjectPicker({ projects, current, path }: { projects: { id: number; name: string }[]; current: number; path: string }) {
  const router = useRouter()
  return (
    <select aria-label="Project" className={`${inputClass} w-auto`} value={current} onChange={e => router.push(`${path}?project=${e.target.value}`)}>
      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  )
}
