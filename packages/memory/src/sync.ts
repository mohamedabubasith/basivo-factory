// Saves the memory branch after a job: commit what the job appended, push, and on a race with another
// job rebase and try again. Different tickets touch different files, so the rebase is clean.

import { git } from './git.ts'

export function commitAndPush(root: string, message: string, { branch = 'factory-memory', tries = 3 } = {}): boolean {
  git(root, 'add', '-A')
  if (git(root, 'status', '--porcelain') === '') return false // nothing new to save
  git(root, 'commit', '-q', '-m', message)
  for (let i = 1; ; i++) {
    try {
      git(root, 'push', '-q', 'origin', `HEAD:${branch}`)
      return true
    } catch (error) {
      if (i >= tries) throw error
      // ponytail: two jobs appending to the same ticket's file at once would conflict here; one job per
      // ticket at a time (the pipeline's design) keeps that from happening.
      git(root, 'pull', '-q', '--rebase', 'origin', branch)
    }
  }
}
