// The only context pushed into an agent run. Everything else the agent pulls through MCP tools.

export const BRIEF_TOKEN_CAP = 2000

// ponytail: chars/4 estimate; switch to a real tokenizer if briefs start running close to the cap.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export type BriefInput = {
  ticket: string
  title: string
  step: { n: number; of: number; task: string; doneWhen: string }
  attempt: { n: number; of: number }
  lastFailure: string | null
  files: string[] // ranked, most relevant first
}

function render(b: BriefInput, files: string[]): string {
  const lines = [
    `Ticket ${b.ticket}: ${b.title}`,
    `Step ${b.step.n}/${b.step.of}: ${b.step.task}`,
    `Done when: ${b.step.doneWhen}`,
    `Attempt ${b.attempt.n} of ${b.attempt.of}.`,
  ]
  if (b.lastFailure) lines.push(`Last attempt failed: ${b.lastFailure}`)
  if (files.length) lines.push('Likely files:', ...files.map(f => `- ${f}`))
  lines.push(
    'Use the factory-memory tools for past attempts, project facts and similar fixes, and the code-graph tools to find code. Do not read the whole repository.',
  )
  return lines.join('\n')
}

// Drops the least relevant files until the brief fits. A brief that still does not fit means the step is
// too big: split it in the plan rather than sending more context.
export function buildBrief(b: BriefInput): string {
  for (let keep = b.files.length; keep >= 0; keep--) {
    const text = render(b, b.files.slice(0, keep))
    if (estimateTokens(text) <= BRIEF_TOKEN_CAP) return text
  }
  throw new Error(`brief for ${b.ticket} step ${b.step.n} exceeds ${BRIEF_TOKEN_CAP} tokens without files: split the step`)
}
