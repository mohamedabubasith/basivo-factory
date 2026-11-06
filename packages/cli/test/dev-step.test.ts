import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { git } from '@basivo-factory/memory'
import { changedFiles } from '../src/dev-step.ts'

test('changed files are exact paths: edits, deletions and new files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-changed-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
  for (const f of ['src/a.js', 'src/b.js']) {
    writeFileSync(join(dir, f.replace('src/', '')), '1')
  }
  writeFileSync(join(dir, 'keep.js'), '1')
  writeFileSync(join(dir, 'gone.js'), '1')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')

  writeFileSync(join(dir, 'a.js'), '2') // the first entry used to lose its first character
  rmSync(join(dir, 'gone.js'))
  writeFileSync(join(dir, 'new.js'), '1')
  expect(changedFiles(dir)).toEqual(['a.js', 'gone.js', 'new.js'])
})
