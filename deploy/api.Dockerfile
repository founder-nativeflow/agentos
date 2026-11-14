# AgentOS API (CMA-compatible /v1 + runtime). Sandboxes run on E2B in the cloud.
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/types packages/types
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile --filter @agentos/api...
ENV NODE_ENV=production \
    AGENTOS_SANDBOX_PROVIDER=e2b \
    AGENTOS_HOME=/data \
    PORT=4000
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "--import", "tsx", "src/index.ts"]
