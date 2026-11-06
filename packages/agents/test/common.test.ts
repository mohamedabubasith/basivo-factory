import { expect, test } from 'vitest'
import { parseReport, reportJsonSchema } from '../src/common.ts'

test('the report schema is strict, as Codex requires', () => {
  const schema = reportJsonSchema() as { additionalProperties: boolean; required: string[] }
  expect(schema.additionalProperties).toBe(false)
  expect(schema).not.toHaveProperty('$schema') // Claude Code rejects the draft 2020-12 reference
  expect([...schema.required].sort()).toEqual(['filesChanged', 'notes', 'summary'])
})

test('a report parses from an object or JSON text, and junk is an error, not a crash', () => {
  const report = { summary: 'fixed sum', filesChanged: ['sum.js'], notes: null }
  expect(parseReport(report).report).toEqual(report)
  expect(parseReport(JSON.stringify(report)).report).toEqual(report)
  expect(parseReport('not json')).toMatchObject({ report: null, error: expect.stringContaining('invalid report') })
})
