# basivo-factory

Takes a ticket from plan to shipped code with Claude Code and Codex, running entirely on CI runners.

```
ticket → plan → human approval → dev → test → fix (max 3) → PR → merge → deploy
```

- **Trackers:** Jira first; YouTrack and native projects later.
- **Forges:** GitHub first; GitLab next, for the office move.
- **Approvals:** the ticket status, or a Microsoft Teams card.
- **Engine:** CI pipelines. There is no always-on service: a ticket waiting for a human is just a status, and no runner sits idle.
- **Memory:** every agent run starts fresh with a brief of at most 2k tokens and pulls everything else through MCP tools. That covers past attempts, project facts, similar fixes and the code graph. Entries carry git blob SHAs, so the tools flag entries about changed files as stale. Tests decide pass or fail, not the agent.

## The crew

Every role has a star name. Agents can run on Claude Code or Codex, chosen per stage.

| Star | Role | Done by |
|---|---|---|
| Capella | intake: reads the ticket, sets up the repo | code |
| Polaris | plan: splits the ticket into steps, each with a test | agent |
| Sirius | dev: builds one step per attempt | agent |
| Rigel | test: runs the tests and decides pass or fail | code |
| Vega | review: reviews the change before the PR | agent |
| Arcturus | ship: opens the PR and deploys | code |

## Configuring the agents

A target repo configures the agents in `.factory/`, the same pattern as Copilot's `.github/agents`, Claude Code's
`.claude/agents` and Factory's droids. Copy `templates/repo/.factory` to start.

```
.factory/
  agents/polaris.md | sirius.md | vega.md   frontmatter (runtime, model, mcp, skills, knowledge, limits) + role prompt
  skills/<name>/SKILL.md                     open Agent Skills format; the same skill works in Claude and Codex
  mcp.json                                   extra MCP servers by name; secrets as ${VAR} from CI secrets
  knowledge/**.md                            decisions, conventions, runbooks
```

What reaches the agent, and how:

| Part | How it reaches the agent |
|---|---|
| Role prompt | Pushed, capped at 6,000 characters |
| Skills | Name and description listed (at most 8); the body loads only when used |
| Knowledge | Never pushed: `kb_search` / `kb_read`, each doc flagged stale when unreviewed, old or its code changed |
| Memory | Never pushed: `ledger` / `facts` / `similar` / `record_fact` |
| MCP servers | Only those the profile lists, plus `factory-memory` |

Agents never see the user's own skills, settings or `~/.agents/skills`, and an agent that edits anything under
`.factory/` has the edit reverted.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | Monorepo, ports, stage machine with the 3-attempt cap, brief builder, CLI, CI | done |
| M1 | Memory branch store, FTS index, staleness, MCP server (code graph wiring pending approval) | done |
| M2 | AgentRunner for Claude Code and Codex: brief, MCP, caps, structured ledger, run logs, claim check | done |
| M3 | GitHub forge, Jira tracker, `factory.yml`, the full stage loop | next |
| M4 | Teams approval card, Vercel deploy, setup docs | |
| M5 | GitLab, YouTrack, native projects, API-key auth | |

## Develop

Needs Node 24 or newer. Node runs the `.ts` files directly, with no build step.

```sh
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
node packages/cli/src/index.ts next --state /tmp/PROJ-1.json --event '{"type":"intake_done"}'
```

## Layout

- `packages/core`: the ports (`Tracker`, `Forge`, `AgentRunner`), the stage machine (`pipeline.ts`), the ledger schemas and the brief builder.
- `packages/cli`: the `factory` command that each CI job runs.
