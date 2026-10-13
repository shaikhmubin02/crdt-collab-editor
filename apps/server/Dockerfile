# Sync server image. Node runs the TypeScript sources directly (type stripping), so there is no
# build step: the image is the workspace's production dependencies plus source.
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/crdt/package.json packages/crdt/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter @collab/server...

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY packages/crdt/src packages/crdt/src
COPY packages/protocol/src packages/protocol/src
COPY apps/server/src apps/server/src
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "apps/server/src/main.ts"]
