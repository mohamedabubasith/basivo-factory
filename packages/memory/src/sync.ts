// Saves the memory branch after a job: commit what the job appended, push, and on a race with another job
// rebase and try again. Memory files are append-only JSONL, so the branch merges them with git's union driver:
// two jobs that each appended lines to the same facts file both keep theirs instead of conflicting.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './git.ts'

const ATTRIBUTES = '*.jsonl merge=union\n'

function ensureUnionMerge(root: string): void {
  const file = join(root, '.gitattributes')
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes('*.jsonl merge=union')) writeFileSync(file, ATTRIBUTES)
}

export function commitAndPush(root: string, message: string, { branch = 'factory-memory', tries = 3 } = {}): boolean {
  ensureUnionMerge(root)
  git(root, 'add', '-A')
  if (git(root, 'status', '--porcelain') === '') return false // nothing new to save
  git(root, '-c', 'user.name=basivo-factory', '-c', 'user.email=factory@users.noreply.github.com', 'commit', '-q', '-m', message)
  for (let i = 1; ; i++) {
    try {
      git(root, 'push', '-q', 'origin', `HEAD:${branch}`)
      return true
    } catch (error) {
      if (i >= tries) throw error
      try {
        git(root, 'pull', '-q', '--rebase', 'origin', branch)
      } catch (rebaseError) {
        // Never leave the checkout mid-rebase: the next job reusing it would fail on every git command.
        try {
          git(root, 'rebase', '--abort')
        } catch {}
        throw rebaseError
      }
    }
  }
}
