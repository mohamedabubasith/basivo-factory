import { expect, test } from 'vitest'
import { BRIEF_TOKEN_CAP, buildBrief, estimateTokens, type BriefInput } from '../src/brief.ts'

const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  ticket: 'PROJ-12',
  title: 'Retry the payment webhook',
  step: { n: 3, of: 7, task: 'add retry to the payment webhook', doneWhen: 'pnpm test webhook_retry' },
  attempt: { n: 2, of: 3 },
  lastFailure: 'timeout in test_webhook_retry (mock clock not advanced)',
  files: ['server/webhooks.ts', 'server/webhooks.test.ts'],
  ...over,
})

test('the brief carries the step, the attempt and the last failure', () => {
  const brief = buildBrief(input())
  expect(brief).toContain('Step 3/7: add retry to the payment webhook')
  expect(brief).toContain('Attempt 2 of 3.')
  expect(brief).toContain('Last attempt failed: timeout in test_webhook_retry')
  expect(brief).toContain('- server/webhooks.ts')
})

test('least relevant files are dropped to stay under the cap', () => {
  const files = Array.from({ length: 2000 }, (_, i) => `src/module-${i}/file.ts`)
  const brief = buildBrief(input({ files }))
  expect(estimateTokens(brief)).toBeLessThanOrEqual(BRIEF_TOKEN_CAP)
  expect(brief).toContain('- src/module-0/file.ts')
  expect(brief).not.toContain('- src/module-1999/file.ts')
})

test('a step too big to brief is refused, not truncated', () => {
  expect(() => buildBrief(input({ step: { n: 1, of: 1, task: 'x'.repeat(9000), doneWhen: 'pnpm test' } }))).toThrow('split the step')
})
