import { describe, expect, it } from 'vitest'
import { formatProfileDoc, MAX_SKILLS, parseProfileDoc } from '../src/profile.ts'

describe('agent profile documents', () => {
  const text = `---
runtime: claude
skills: [write-failing-test]
knowledge: [".factory/knowledge/**/*.md", "docs/**/*.md"]
maxTurns: 60
maxBudgetUsd: 5
---
You are Sirius, the developer.
`

  it('round-trips a profile without changing it', () => {
    expect(formatProfileDoc(parseProfileDoc(text))).toBe(text)
  })

  it('writes only the settings that are set', () => {
    expect(formatProfileDoc({ settings: { runtime: 'codex', mcp: [], skills: [], knowledge: [] }, instructions: 'Review.' }))
      .toBe('---\nruntime: codex\n---\nReview.\n')
  })

  it('rejects too many skills and bad values', () => {
    const skills = Array.from({ length: MAX_SKILLS + 1 }, (_, i) => `s${i}`)
    expect(() => formatProfileDoc({ settings: { runtime: 'claude', mcp: [], skills, knowledge: [] }, instructions: '' })).toThrow(/skills/)
    expect(() => parseProfileDoc('---\nruntime: gpt\n---\n')).toThrow()
  })
})
