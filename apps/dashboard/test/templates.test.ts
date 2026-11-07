import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { FACTORY_WORKFLOW } from '../src/lib/templates.ts'

it('the workflow the dashboard writes matches the one in templates/', () => {
  expect(FACTORY_WORKFLOW).toBe(readFileSync(new URL('../../../templates/github/factory-jira.yml', import.meta.url), 'utf8'))
})
