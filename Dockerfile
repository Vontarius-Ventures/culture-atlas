# syntax=docker/dockerfile:1.7
#
# One image for the culture atlas web app and the job worker.
#   web (default):  next start on $PORT (default 3000)
#   worker:         docker run <image> pnpm worker
#   migrations:     docker run <image> pnpm db:migrate   (run before each release)
#
# Workspace packages ship TypeScript source; the worker and scripts run under
# tsx, so the runtime image keeps the full workspace install.
# The World Sensor bridge (apps/sensor-bridge) is NOT deployed here: it runs on
# the machine next to the relay (see docs/sensor.md).

ARG NODE_VERSION=22.20.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# Dependencies (cached until a manifest or the lockfile changes).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/demo-agent/package.json apps/demo-agent/
COPY apps/sensor-bridge/package.json apps/sensor-bridge/
COPY packages/domain/package.json packages/domain/
COPY packages/providers/package.json packages/providers/
COPY packages/agent-gateway/package.json packages/agent-gateway/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# Build the Next.js app.
FROM deps AS build
COPY . .
RUN pnpm --filter @culture-atlas/web build

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "cd apps/web && exec node_modules/.bin/next start -H 0.0.0.0 -p \"${PORT:-3000}\""]
