import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git } from '../src/git.ts'

export const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), `factory-${prefix}-`))

// A git repo with the given files committed. `commit` writes more files and commits them.
export function repoWith(files: Record<string, string>) {
  const dir = tempDir('repo')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  const commit = (changes: Record<string, string>, message = 'change') => {
    for (const [path, body] of Object.entries(changes)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), body)
    }
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', message)
  }
  commit(files, 'initial')
  return { dir, commit }
}
