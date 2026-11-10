// .factory/review.md: the team's rules for the reviewer. Frontmatter sets the knobs; the body is free text the
// finders read as trusted instructions. Always taken from the base branch, never from the change under review.

import { splitFrontmatter } from '@basivo-factory/core'
import { z } from 'zod'
import { DEFAULT_RULES, type RankRules } from './rank.ts'
import { SEVERITIES } from './schema.ts'

const Settings = z.object({
  verifier: z.enum(['claude', 'codex']).default('claude'),
  finders: z.enum(['claude', 'codex']).default('claude'),
  model: z.string().optional(), // model for the finders (the runtime's default when unset)
  verifier_model: z.string().optional(), // model for the verifier; needed when the verifier is another runtime
  max_comments: z.number().int().min(0).max(30).default(DEFAULT_RULES.maxComments),
  block_on: z.array(z.enum(SEVERITIES)).default(DEFAULT_RULES.blockOn),
  min_confidence: z.number().min(0).max(1).default(DEFAULT_RULES.minConfidence),
  ignore: z.array(z.string()).default([]),
  max_changed_lines: z.number().int().positive().default(2500),
  review_bots: z.boolean().default(false),
  max_budget_usd: z.number().positive().default(3),
})

export type ReviewConfig = z.infer<typeof Settings> & { rules: string; rank: RankRules }

// Always skipped: nobody wants comments on a lockfile or a build artefact.
export const ALWAYS_IGNORE = ['**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock', '**/*.min.js', '**/*.min.css', '**/dist/**', '**/build/**', '**/*.map', '**/vendor/**']

export function parseConfig(text: string | null): ReviewConfig {
  const { data, body } = text ? splitFrontmatter(text) : { data: {}, body: '' }
  const s = Settings.parse(data)
  return { ...s, rules: body.trim(), rank: { maxComments: s.max_comments, blockOn: s.block_on, minConfidence: s.min_confidence } }
}

export const DEFAULT_CONFIG_TEXT = `---
# Settings for basivo-review. Read from the main branch only.
verifier: claude          # which model family double-checks each finding (codex when configured)
max_comments: 5           # inline comments per review; the rest go into the summary
block_on: [security, bug, data]   # severities that make the verdict "needs changes"
ignore: []                # extra path globs to leave out, e.g. ["docs/**", "**/*.generated.ts"]
---
# Review rules

What the reviewer should flag and what it should leave alone. Plain language; the reviewer reads this before it
reads the change.

- Flag anything that breaks a documented decision in .factory/knowledge/.
- Do not comment on formatting, naming or style; linters handle those.
`
