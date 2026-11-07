import { MAX_INSTRUCTIONS_CHARS, MAX_SKILLS, parseProfileDoc, type ProfileDoc } from '@basivo-factory/core'
import { ActionForm } from '@/components/action-form'
import { Card, Empty, Field, inputClass, PageHeader, textareaClass } from '@/components/ui'
import { repoClient } from '@/lib/github'
import { listProjects } from '@/lib/projects'
import { saveAgent } from '../actions'
import { ProjectPicker } from '../project-picker'

const AGENTS = [
  { star: 'polaris', name: 'Polaris', role: 'Planner: splits a ticket into steps, each with a test.' },
  { star: 'sirius', name: 'Sirius', role: 'Developer: builds one step at a time.' },
  { star: 'vega', name: 'Vega', role: 'Reviewer: checks the change before the pull request.' },
] as const

export default async function Agents({ searchParams }: PageProps<'/agents'>) {
  const projects = await listProjects()
  if (projects.length === 0) return (<><PageHeader title="Agents" /><Empty>Link a project first.</Empty></>)
  const { project: q } = await searchParams
  const p = projects.find(x => String(x.id) === q) ?? projects[0]!
  const gh = repoClient(p.installationId, p.repo)
  const [files, skillDirs, mcpFile] = await Promise.all([
    Promise.all(AGENTS.map(a => gh.getFile(`.factory/agents/${a.star}.md`))),
    gh.listDir('.factory/skills'),
    gh.getFile('.factory/mcp.json'),
  ])
  const skills = skillDirs.filter(d => d.type === 'dir').map(d => d.name)
  let mcpServers: string[] = []
  try {
    mcpServers = mcpFile ? Object.keys((JSON.parse(mcpFile.text) as { servers?: Record<string, unknown> }).servers ?? {}) : []
  } catch { /* shown as none */ }

  return (
    <>
      <PageHeader title="Agents" sub={<>Settings live in <code>{p.repo}/.factory/agents/</code>; saving commits there, and the next run uses them.</>}
        action={<ProjectPicker projects={projects.map(x => ({ id: x.id, name: x.name }))} current={p.id} path="/agents" />} />
      <div className="grid gap-4 xl:grid-cols-3">
        {AGENTS.map((a, i) => {
          let doc: ProfileDoc | null = null
          let broken: string | null = null
          try {
            doc = files[i] ? parseProfileDoc(files[i]!.text) : null
          } catch (e) {
            broken = (e as Error).message
          }
          const s = doc?.settings
          return (
            <Card key={a.star} title={<span>{a.name} <span className="font-normal text-muted">· {a.role}</span></span>}>
              {broken ? <p className="mb-3 text-sm text-bad">The file in the repo is invalid: {broken}. Saving replaces it.</p> : null}
              {!files[i] ? <p className="mb-3 text-sm text-muted">No settings file yet: the agent uses the defaults. Saving creates it.</p> : null}
              <ActionForm action={saveAgent.bind(null, p.id, a.star)} submit="Save">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Runs on">
                    <select name="runtime" className={inputClass} defaultValue={s?.runtime ?? 'claude'}>
                      <option value="claude">Claude Code</option><option value="codex">Codex</option>
                    </select>
                  </Field>
                  <Field label="Model" hint="Empty: the default."><input name="model" className={inputClass} defaultValue={s?.model ?? ''} /></Field>
                  <Field label="Max turns"><input name="maxTurns" type="number" min={1} className={inputClass} defaultValue={s?.maxTurns ?? ''} /></Field>
                  <Field label="Cost limit ($)"><input name="maxBudgetUsd" type="number" min={0.1} step={0.1} className={inputClass} defaultValue={s?.maxBudgetUsd ?? ''} /></Field>
                </div>
                <Field label={`Skills (max ${MAX_SKILLS})`} hint={skills.length ? 'From .factory/skills/ in the repo.' : 'No skills in .factory/skills/ yet.'}>
                  <div className="flex flex-wrap gap-3 text-sm">
                    {skills.map(k => <label key={k} className="flex items-center gap-1"><input type="checkbox" name="skills" value={k} defaultChecked={s?.skills.includes(k)} />{k}</label>)}
                  </div>
                </Field>
                <Field label="Tools (MCP servers)" hint={mcpServers.length ? 'From .factory/mcp.json.' : 'None defined in .factory/mcp.json.'}>
                  <div className="flex flex-wrap gap-3 text-sm">
                    {mcpServers.map(k => <label key={k} className="flex items-center gap-1"><input type="checkbox" name="mcp" value={k} defaultChecked={s?.mcp.includes(k)} />{k}</label>)}
                  </div>
                </Field>
                <Field label="Knowledge to search" hint="File patterns, one per line."><textarea name="knowledge" rows={2} className={textareaClass} defaultValue={s?.knowledge.join('\n') ?? ''} /></Field>
                <Field label="Instructions" hint={`Added to every run of this agent. Max ${MAX_INSTRUCTIONS_CHARS} characters.`}>
                  <textarea name="instructions" rows={7} maxLength={MAX_INSTRUCTIONS_CHARS} className={textareaClass} defaultValue={doc?.instructions ?? ''} />
                </Field>
              </ActionForm>
            </Card>
          )
        })}
      </div>
    </>
  )
}
