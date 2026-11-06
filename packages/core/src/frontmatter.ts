// Markdown with a YAML header, the format of agent profiles, SKILL.md files and knowledge docs.

import { parse } from 'yaml'

export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { data: {}, body: text }
  const data = parse(match[1]!) as unknown
  return { data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {}, body: match[2]! }
}
