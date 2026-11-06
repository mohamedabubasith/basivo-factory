// Every role on the line has a star name. They label run logs, Jira comments, Teams cards and the World view,
// so a reader sees "Sirius (claude) failed attempt 2" instead of a stage id.

export const ROLES = {
  intake: { star: 'Capella', kind: 'code', job: 'reads the ticket, sets up the repo' },
  plan: { star: 'Polaris', kind: 'agent', job: 'splits the ticket into steps, each with a test' },
  dev: { star: 'Sirius', kind: 'agent', job: 'builds one step per attempt' },
  test: { star: 'Rigel', kind: 'code', job: 'runs the tests and decides pass or fail' },
  review: { star: 'Vega', kind: 'agent', job: 'reviews the change before the PR' },
  ship: { star: 'Arcturus', kind: 'code', job: 'opens the PR and deploys' },
} as const

export type Role = keyof typeof ROLES

// "Sirius (claude)": the role's star with the runtime doing the work, when an agent does it.
export const roleLabel = (role: Role, runtime?: string): string =>
  runtime ? `${ROLES[role].star} (${runtime})` : ROLES[role].star
