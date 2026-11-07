import { describe, expect, it } from 'vitest'
import { matchTrigger } from '../src/lib/triggers.ts'

const project = { jiraProject: 'BL', startStatus: 'Selected for Development', approveCommand: '/approve', approvers: ['acc-me'] }
const moved = (to: string, by = 'acc-me', key = 'BL-7') => ({
  webhookEvent: 'jira:issue_updated', user: { accountId: by }, issue: { key },
  changelog: { items: [{ field: 'assignee', toString: 'Abu' }, { field: 'status', toString: to }] },
})
const comment = (body: unknown, by = 'acc-me', key = 'BL-7') => ({
  webhookEvent: 'comment_created', issue: { key }, comment: { body, author: { accountId: by } },
})

describe('matchTrigger', () => {
  it('starts the plan when the ticket moves into the start column', () => {
    expect(matchTrigger(moved('Selected for Development'), project)).toEqual({ action: 'plan', ticket: 'BL-7', by: 'acc-me' })
  })
  it('ignores other columns and edits without a status change', () => {
    expect(matchTrigger(moved('In Progress'), project)).toHaveProperty('ignored')
    expect(matchTrigger({ ...moved('x'), changelog: { items: [{ field: 'summary', toString: 'new' }] } }, project)).toHaveProperty('ignored')
  })
  it('builds on the approve comment, plain text or Jira rich text', () => {
    expect(matchTrigger(comment('/approve'), project)).toMatchObject({ action: 'build' })
    expect(matchTrigger(comment('  /Approve \n'), project)).toMatchObject({ action: 'build' })
    expect(matchTrigger(comment({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '/approve' }] }] }), project)).toMatchObject({ action: 'build' })
  })
  it('stops on /stop and ignores ordinary comments, including ones that only mention /approve', () => {
    expect(matchTrigger(comment('/stop'), project)).toMatchObject({ action: 'stop' })
    expect(matchTrigger(comment('looks good, will /approve later'), project)).toHaveProperty('ignored')
  })
  it('ignores people who are not approvers', () => {
    expect(matchTrigger(moved('Selected for Development', 'acc-stranger'), project)).toHaveProperty('ignored')
    expect(matchTrigger(comment('/approve', 'acc-stranger'), project)).toHaveProperty('ignored')
  })
  it('ignores tickets of other projects and malformed keys', () => {
    expect(matchTrigger(moved('Selected for Development', 'acc-me', 'BAS-3'), project)).toHaveProperty('ignored')
    expect(matchTrigger(moved('Selected for Development', 'acc-me', 'BL-7; rm -rf /'), project)).toHaveProperty('ignored')
  })
})
