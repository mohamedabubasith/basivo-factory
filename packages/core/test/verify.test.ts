import { expect, test } from 'vitest'
import { checkClaims } from '../src/verify.ts'

test('a claimed change that git does not show is flagged as dishonest', () => {
  const check = checkClaims({ summary: 's', filesChanged: ['./src/a.ts', 'src/b.ts'], notes: null }, ['src/a.ts', 'src/c.ts'])
  expect(check).toEqual({ claimedButUnchanged: ['src/b.ts'], changedButUnclaimed: ['src/c.ts'], honest: false })
})

test('an accurate report is honest even when it leaves out a change', () => {
  expect(checkClaims({ summary: 's', filesChanged: ['a.ts'], notes: null }, ['a.ts', 'b.ts']).honest).toBe(true)
})
