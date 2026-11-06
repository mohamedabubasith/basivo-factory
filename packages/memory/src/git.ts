import { execFileSync } from 'node:child_process'

export const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()

export const headCommit = (repoDir: string): string => git(repoDir, 'rev-parse', 'HEAD')

// Recorded for a path that does not exist, so a file that was deleted (and stays deleted) is not stale.
export const DELETED = 'deleted'

// Blob SHA of each path at `rev`; a path missing at `rev` maps to DELETED. -z keeps unusual paths unquoted.
export function blobShas(repoDir: string, paths: string[], rev = 'HEAD'): Record<string, string> {
  if (paths.length === 0) return {}
  const shas: Record<string, string> = Object.fromEntries(paths.map(p => [p, DELETED]))
  for (const record of git(repoDir, 'ls-tree', '-r', '-z', rev, '--', ...paths).split('\0')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(record)
    if (match) shas[match[2]!] = match[1]!
  }
  return shas
}

// Paths whose content changed (or that appeared or vanished) since the entry was recorded. Empty = still current.
export function changedPaths(recorded: Record<string, string>, current: Record<string, string>): string[] {
  return Object.keys(recorded).filter(path => recorded[path] !== (current[path] ?? DELETED))
}
