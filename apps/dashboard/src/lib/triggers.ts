// Turns a Jira webhook into what the pipeline should do. Pure, so every rule is tested without Jira.
//   ticket moved into the start column        → plan
//   comment that is exactly the approve word  → build
//   comment "/stop"                           → stop
// Only Jira accounts on the project's approver list can trigger anything; everyone else is ignored.

import { adfToText, JIRA_KEY } from '@basivo-factory/trackers'

export type TriggerProject = { jiraProject: string; startStatus: string; approveCommand: string; approvers: string[] }
export type Trigger = { action: 'plan' | 'build' | 'stop'; ticket: string; by: string }

type JiraEvent = {
  webhookEvent?: string
  user?: { accountId?: string }
  issue?: { key?: string }
  changelog?: { items?: { field?: string; toString?: string | null }[] }
  comment?: { body?: unknown; author?: { accountId?: string } }
}

const commentText = (body: unknown) =>
  (typeof body === 'string' ? body : adfToText(body as Parameters<typeof adfToText>[0])).trim()

export function matchTrigger(event: JiraEvent, project: TriggerProject): Trigger | { ignored: string } {
  const ticket = event.issue?.key ?? ''
  if (!JIRA_KEY.test(ticket)) return { ignored: 'no ticket key' }
  if (!ticket.startsWith(`${project.jiraProject}-`)) return { ignored: `ticket ${ticket} is not in ${project.jiraProject}` }

  if (event.webhookEvent === 'jira:issue_updated') {
    const by = event.user?.accountId ?? ''
    const moved = event.changelog?.items?.find(i => i.field === 'status')
    if (!moved) return { ignored: 'not a status change' }
    if ((moved.toString ?? '').toLowerCase() !== project.startStatus.toLowerCase()) return { ignored: `moved to "${moved.toString}"` }
    if (!project.approvers.includes(by)) return { ignored: 'moved by someone not on the approver list' }
    return { action: 'plan', ticket, by }
  }

  if (event.webhookEvent === 'comment_created') {
    const by = event.comment?.author?.accountId ?? ''
    const text = commentText(event.comment?.body).toLowerCase()
    const action = text === project.approveCommand.toLowerCase() ? 'build' : text === '/stop' ? 'stop' : null
    if (!action) return { ignored: 'ordinary comment' }
    if (!project.approvers.includes(by)) return { ignored: 'comment by someone not on the approver list' }
    return { action, ticket, by }
  }

  return { ignored: `event ${event.webhookEvent ?? 'unknown'}` }
}
