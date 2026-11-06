import { execFileSync } from 'node:child_process'

export const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export const headCommit = (repoDir: string): string => git(repoDir, 'rev-parse', 'HEAD')

// Blob SHA of each path at `rev`. A path missing from the result was deleted or never existed there.
export function blobShas(repoDir: string, paths: string[], rev = 'HEAD'): Record<string, string> {
  if (paths.length === 0) return {}
  const out = git(repoDir, 'ls-tree', '-r', rev, '--', ...paths)
  const shas: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line)
    if (match) shas[match[2]!] = match[1]!
  }
  return shas
}

// Paths whose content changed (or vanished) since the entry was recorded. Empty means still current.
export function changedPaths(recorded: Record<string, string>, current: Record<string, string>): string[] {
  return Object.keys(recorded).filter(path => recorded[path] !== current[path])
}
