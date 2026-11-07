# The dashboard as one container (Coolify, or any Docker host). Build from the repo root:
#   docker build -f apps/dashboard/Dockerfile -t basivo-factory-dashboard .
# Runtime env: DATABASE_URL, FACTORY_SECRET, ADMIN_GITHUB_LOGINS, APP_URL.
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --filter "@basivo-factory/dashboard..."
RUN pnpm --filter @basivo-factory/dashboard build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /repo/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/setup >/dev/null 2>&1 || exit 1
CMD ["node", "apps/dashboard/server.js"]
