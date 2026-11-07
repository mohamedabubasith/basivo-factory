import 'server-only'
import { drizzle } from 'drizzle-orm/postgres-js'
import { bigint, integer, jsonb, numeric, pgSchema, serial, text, timestamp } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import { env } from './env'

// Own schema, not "public": Supabase serves "public" through its REST API, and these rows hold encrypted keys.
const factory = pgSchema('factory')

// One row per connected service: github_app, jira, claude. Non-secret details in config, keys in secret (encrypted).
export const connections = factory.table('connections', {
  kind: text('kind').primaryKey(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  secret: text('secret'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const projects = factory.table('projects', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  jiraProject: text('jira_project').notNull(),
  repo: text('repo').notNull(), // owner/name
  installationId: bigint('installation_id', { mode: 'number' }).notNull(),
  startStatus: text('start_status').notNull(),
  approveCommand: text('approve_command').notNull().default('/approve'),
  runsOn: text('runs_on').notNull().default('ubuntu-latest'),
  approvers: jsonb('approvers').$type<string[]>().notNull().default([]), // Jira account ids allowed to start/approve
  webhookId: text('webhook_id'),
  webhookTokenHash: text('webhook_token_hash'),
  webhookSecret: text('webhook_secret'), // encrypted
  ingestTokenHash: text('ingest_token_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const runs = factory.table('runs', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull(),
  ticket: text('ticket').notNull(),
  kind: text('kind').notNull(), // plan | build | all
  ghRunId: bigint('gh_run_id', { mode: 'number' }).notNull().unique(),
  status: text('status').notNull().default('running'), // running | waiting | succeeded | failed | cancelled
  stage: text('stage'),
  detail: text('detail'),
  costUsd: numeric('cost_usd', { mode: 'number' }),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  prUrl: text('pr_url'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const runEvents = factory.table('run_events', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
})

export const auditLog = factory.table('audit_log', {
  id: serial('id').primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
})

// Creates the schema on first use. Every statement is idempotent, so a cold start on any instance is safe.
const BOOTSTRAP = `
create schema if not exists factory;
create table if not exists factory.connections (
  kind text primary key, config jsonb not null default '{}', secret text, updated_at timestamptz not null default now());
create table if not exists factory.projects (
  id serial primary key, name text not null, jira_project text not null, repo text not null,
  installation_id bigint not null, start_status text not null, approve_command text not null default '/approve',
  runs_on text not null default 'ubuntu-latest', approvers jsonb not null default '[]', webhook_id text,
  webhook_token_hash text, webhook_secret text, ingest_token_hash text, created_at timestamptz not null default now());
create table if not exists factory.runs (
  id serial primary key, project_id integer not null references factory.projects(id) on delete cascade,
  ticket text not null, kind text not null, gh_run_id bigint not null unique, status text not null default 'running',
  stage text, detail text, cost_usd numeric, input_tokens integer, output_tokens integer, pr_url text,
  started_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists factory.run_events (
  id serial primary key, run_id integer not null references factory.runs(id) on delete cascade,
  at timestamptz not null default now(), kind text not null, data jsonb not null default '{}');
create index if not exists run_events_run on factory.run_events(run_id, id);
create table if not exists factory.audit_log (
  id serial primary key, at timestamptz not null default now(), actor text not null, action text not null,
  detail jsonb not null default '{}');
`

type Db = ReturnType<typeof drizzle>
const g = globalThis as unknown as { __factoryDb?: { db: Db; ready: Promise<void> } }

export async function db(): Promise<Db> {
  if (!g.__factoryDb) {
    // prepare: false works through Supabase's transaction pooler as well as a direct connection.
    const sql = postgres(env.databaseUrl, { prepare: false, max: 5 })
    g.__factoryDb = { db: drizzle(sql), ready: sql.unsafe(BOOTSTRAP).then(() => undefined) }
  }
  try {
    await g.__factoryDb.ready
  } catch (e) {
    g.__factoryDb = undefined // retry the bootstrap on the next request
    throw e
  }
  return g.__factoryDb.db
}

export async function audit(actor: string, action: string, detail: Record<string, unknown> = {}) {
  await (await db()).insert(auditLog).values({ actor, action, detail })
}
