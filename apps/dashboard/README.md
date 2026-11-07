# basivo-factory dashboard

One place to connect GitHub and Jira, link a Jira project to a repo, choose where jobs run, edit agent settings,
and watch runs live. Agents still run on CI runners; this app sets them up and starts them.

## Deploy (once)

1. Create a Vercel project with root directory `apps/dashboard`.
2. Set three environment variables:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Postgres connection string (the self-hosted Supabase). Tables go in their own `factory` schema, created on first start. |
   | `FACTORY_SECRET` | A long random string, for example from `openssl rand -hex 32`. Encryption and login keys come from it; changing it makes stored keys unreadable. |
   | `ADMIN_GITHUB_LOGINS` | GitHub logins allowed to sign in, comma-separated. |

   Optional: `APP_URL` when the dashboard is not on the Vercel production domain.
3. Open the dashboard and click **Create GitHub App**, then install it on the repos the agents may use.
4. Sign in with GitHub. On **Connections**, add the Jira site, email and API token, and the Claude token.
5. On **Projects**, link a Jira project to a repo. The dashboard adds the workflow, the secrets and variables, and a
   Jira webhook. Moving a ticket to the chosen column now starts planning.

## Develop

```sh
pnpm install
DATABASE_URL=postgres://... FACTORY_SECRET=... ADMIN_GITHUB_LOGINS=you pnpm -F @basivo-factory/dashboard dev
pnpm test                                                        # unit tests (repo root)
TEST_DATABASE_URL=postgres://... pnpm vitest run apps/dashboard  # plus the database tests
```

GitHub and Jira must reach the app for webhooks, so test those parts on a Vercel preview.
