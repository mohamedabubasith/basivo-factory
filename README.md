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
