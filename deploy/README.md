# Run the basivo-factory dashboard on your own server

One Docker Compose file starts the dashboard and its own Postgres. Nothing else is needed on the server.

## Requirements

- A Linux server with Docker and Docker Compose.
- An HTTPS address for it (company reverse proxy, load balancer or similar) that GitHub and Jira can reach:
  they send events to the dashboard.

## Start

```sh
mkdir basivo-factory && cd basivo-factory
curl -fsSLO https://raw.githubusercontent.com/mohamedabubasith/basivo-factory/main/deploy/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/mohamedabubasith/basivo-factory/main/deploy/.env.example -o .env
# edit .env: APP_URL, ADMIN_GITHUB_LOGINS, FACTORY_SECRET and POSTGRES_PASSWORD (openssl rand -hex 32 for each secret)
docker compose pull && docker compose up -d
```

Point the HTTPS proxy at port 3000 (or `DASHBOARD_PORT`). Open `APP_URL`; the setup page walks through the rest:

1. **Create GitHub App**, then install it on the repos the agents may work on.
2. **Sign in with GitHub** (only logins in `ADMIN_GITHUB_LOGINS`).
3. **Connections**: Jira site, email and API token; Claude token.
4. **Projects**: link a Jira project to a repo.

## Operate

| Task | Command |
|---|---|
| Update | `docker compose pull && docker compose up -d` |
| Logs | `docker compose logs -f dashboard` |
| Back up the database | `docker compose exec db pg_dump -U factory factory > backup.sql` |
| Restore | `docker compose exec -T db psql -U factory factory < backup.sql` |

Keep `.env` and the backups private: with `FACTORY_SECRET` they unlock every connected account.
The database has no published port; only the dashboard container reaches it.

To use an existing Postgres instead (for example a company database), remove the `db` service and set
`DATABASE_URL` for the dashboard. Its tables are created in their own `factory` schema on first start.
