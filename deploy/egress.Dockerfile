# AgentOS egress proxy (allow-lists + secret injection) for cloud sandboxes.
# Env: EGRESS_ADMIN_SECRET, EGRESS_CA_PEM, EGRESS_CA_KEY (PEM; \n escapes allowed).
# Ports: 3128 proxy (public TCP proxy), 3129 admin (private network only).
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/types packages/types
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile --filter @agentos/api...
RUN cd apps/api && node -e "require('esbuild').buildSync({entryPoints:['src/egress/proxy.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',outfile:'/out/proxy.cjs'})"

FROM node:22-alpine
COPY --from=build /out/proxy.cjs /app/proxy.cjs
ENV EGRESS_CA_DIR=/egress
EXPOSE 3128 3129
CMD ["sh", "-c", "mkdir -p /egress && printf '%b' \"$EGRESS_CA_PEM\" > /egress/ca.pem && printf '%b' \"$EGRESS_CA_KEY\" > /egress/ca.key && chmod 600 /egress/ca.key && exec node /app/proxy.cjs"]
