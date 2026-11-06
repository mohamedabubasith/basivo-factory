import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { loadProfile, MAX_INSTRUCTIONS_CHARS } from '../src/profile.ts'
import { claudeSkillPlugin, codexSkillConfig } from '../src/skills.ts'

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-profile-'))
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), body)
  }
  return dir
}

const skill = (name: string, description = `Use when ${name} applies.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`

test('a repo without .factory/ gets the defaults', () => {
  const p = loadProfile(repo({}), 'dev')
  expect(p).toMatchObject({ star: 'Sirius', runtime: 'claude', instructions: '', skillRefs: [], mcpServers: {}, knowledge: [] })
})

test('a profile brings its prompt, skills, MCP servers with secrets filled in, and knowledge globs', () => {
  const dir = repo({
    '.factory/agents/vega.md': '---\nruntime: codex\nmodel: gpt-6-luna\nmcp: [playwright]\nskills: [review-checklist]\nknowledge: ["docs/**/*.md"]\nmaxTurns: 12\n---\nYou are Vega. Review for correctness first.\n',
    '.factory/skills/review-checklist/SKILL.md': skill('review-checklist'),
    '.factory/mcp.json': JSON.stringify({ servers: { playwright: { command: 'npx', args: ['@playwright/mcp', '--token', '${PW_TOKEN}'] } } }),
  })
  process.env.PW_TOKEN = 'pw-secret'
  try {
    const p = loadProfile(dir, 'review')
    expect(p).toMatchObject({ star: 'Vega', runtime: 'codex', model: 'gpt-6-luna', maxTurns: 12, instructions: 'You are Vega. Review for correctness first.', knowledge: ['docs/**/*.md'] })
    expect(p.skillRefs).toEqual([{ name: 'review-checklist', description: 'Use when review-checklist applies.', dir: join(dir, '.factory/skills/review-checklist') }])
    expect(p.mcpServers.playwright).toEqual({ command: 'npx', args: ['@playwright/mcp', '--token', 'pw-secret'], env: {} })
  } finally {
    delete process.env.PW_TOKEN
  }
})

test('broken profiles fail loudly, naming the file and the problem', () => {
  const agent = (front: string, body = 'x') => ({ '.factory/agents/sirius.md': `---\n${front}\n---\n${body}\n` })
  expect(() => loadProfile(repo(agent('skills: [missing]')), 'dev')).toThrow('no SKILL.md')
  expect(() => loadProfile(repo({ ...agent('skills: [Bad_Name]'), '.factory/skills/Bad_Name/SKILL.md': skill('Bad_Name') }), 'dev')).toThrow('lowercase')
  expect(() => loadProfile(repo({ ...agent('skills: [a]'), '.factory/skills/a/SKILL.md': skill('b') }), 'dev')).toThrow('must match its folder')
  expect(() => loadProfile(repo(agent('mcp: [jira]')), 'dev')).toThrow('mcp.json does not exist')
  expect(() => loadProfile(repo({ ...agent('mcp: [jira]'), '.factory/mcp.json': JSON.stringify({ servers: { jira: { command: 'x', env: { T: '${NOPE_UNSET}' } } } }) }), 'dev')).toThrow('NOPE_UNSET is not set')
  expect(() => loadProfile(repo(agent('runtime: gemini')), 'dev')).toThrow('sirius.md')
  expect(() => loadProfile(repo(agent('', 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 1))), 'dev')).toThrow('move detail into a skill')
})

test('Claude gets a throwaway plugin holding exactly the chosen skills', () => {
  const dir = repo({ '.factory/skills/a/SKILL.md': skill('a') })
  const plugin = claudeSkillPlugin([{ name: 'a', description: 'd', dir: join(dir, '.factory/skills/a') }])!
  expect(plugin.names).toEqual(['factory:a'])
  expect(JSON.parse(readFileSync(join(plugin.path, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('factory')
  expect(readFileSync(join(plugin.path, 'skills/a/SKILL.md'), 'utf8')).toContain('Body of a.')
  plugin.done()
  expect(existsSync(plugin.path)).toBe(false)
  expect(claudeSkillPlugin([])).toBeNull()
})

test('Codex sees the chosen skills; every other skill on disk and the bundled ones are switched off', () => {
  const home = repo({ '.agents/skills/personal/SKILL.md': skill('personal') })
  const work = repo({ '.agents/skills/repo-own/SKILL.md': skill('repo-own'), '.factory/skills/chosen/SKILL.md': skill('chosen') })
  const codexHome = mkdtempSync(join(tmpdir(), 'factory-codex-home-'))
  const before = process.env.HOME
  process.env.HOME = home
  try {
    const config = codexSkillConfig([{ name: 'chosen', description: 'd', dir: join(work, '.factory/skills/chosen') }], codexHome, work) as {
      include_instructions: boolean; bundled: { enabled: boolean }; config: { path: string; enabled: boolean }[]
    }
    expect(config.include_instructions).toBe(true)
    expect(config.bundled.enabled).toBe(false)
    const off = config.config.map(c => realpathSync(c.path)).sort()
    expect(off).toEqual([realpathSync(join(home, '.agents/skills/personal/SKILL.md')), realpathSync(join(work, '.agents/skills/repo-own/SKILL.md'))].sort())
    expect(config.config.every(c => c.enabled === false)).toBe(true)
    expect(readFileSync(join(codexHome, 'skills/chosen/SKILL.md'), 'utf8')).toContain('Body of chosen.')
  } finally {
    process.env.HOME = before
  }
  expect(codexSkillConfig([], codexHome, work)).toEqual({ include_instructions: false })
})

test('the template profiles shipped in templates/repo load and validate', () => {
  const template = join(import.meta.dirname, '../../../templates/repo')
  expect(loadProfile(template, 'plan')).toMatchObject({ star: 'Polaris', skillRefs: [{ name: 'write-failing-test' }] })
  expect(loadProfile(template, 'dev')).toMatchObject({ star: 'Sirius', maxBudgetUsd: 2 })
  expect(loadProfile(template, 'review')).toMatchObject({ star: 'Vega', runtime: 'codex' })
})
