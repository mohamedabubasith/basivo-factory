import { expect, test } from 'vitest'
import { checkClaims } from '../src/verify.ts'

test('a claimed change that git does not show is flagged as dishonest', () => {
  const check = checkClaims({ summary: 's', filesChanged: ['./src/a.ts', 'src/b.ts'], notes: null }, ['src/a.ts', 'src/c.ts'])
  expect(check).toEqual({ claimedButUnchanged: ['src/b.ts'], changedButUnclaimed: ['src/c.ts'], honest: false })
})

test('an accurate report is honest even when it leaves out a change', () => {
  expect(checkClaims({ summary: 's', filesChanged: ['a.ts'], notes: null }, ['a.ts', 'b.ts']).honest).toBe(true)
})

test('a failure signature ignores numbers, timings and paths but not the failure itself', async () => {
  const { failureSignature } = await import('../src/verify.ts')
  const a = failureSignature('✖ totals rounded (0.31ms)\n  expected 0.3, got 0.30000000000000004 at /tmp/run-1/src/cart.js:7')
  const b = failureSignature('✖ totals rounded (0.52ms)\n  expected 0.3, got 0.30000000000000004 at /tmp/run-2/src/cart.js:9')
  const c = failureSignature('✖ a line costs price times quantity\n  expected 10, got 2.5')
  expect(a).toBe(b)
  expect(a).not.toBe(c)
})

test('every role has a star name, and agent labels carry the runtime', async () => {
  const { ROLES, roleLabel } = await import('../src/roles.ts')
  expect(Object.values(ROLES).map(r => r.star)).toEqual(['Capella', 'Polaris', 'Sirius', 'Rigel', 'Vega', 'Arcturus'])
  expect(roleLabel('dev', 'claude')).toBe('Sirius (claude)')
  expect(roleLabel('test')).toBe('Rigel')
})
