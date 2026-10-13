# Web app image (Next.js standalone server). NEXT_PUBLIC_SYNC_URL is inlined at build time:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_SYNC_URL=wss://example.com/sync .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @collab/web...
ARG NEXT_PUBLIC_SYNC_URL
ENV NEXT_PUBLIC_SYNC_URL=$NEXT_PUBLIC_SYNC_URL NEXT_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @collab/web build

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
