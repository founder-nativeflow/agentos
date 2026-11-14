# AgentOS Console: static build served by Caddy, which also proxies /v1 to the API
# (same origin, so the Console's session cookie works).
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/types packages/types
COPY apps/console apps/console
RUN pnpm install --frozen-lockfile --filter @agentos/console...
RUN pnpm --filter @agentos/console build

FROM caddy:2.8.4-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/console/dist /srv
ENV PORT=8080
EXPOSE 8080
