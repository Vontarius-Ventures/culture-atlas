# syntax=docker/dockerfile:1.7
#
# One image for the culture atlas web app and the job worker.
#   web (default):  next start on $PORT (default 3000)
#   worker:         docker run <image> pnpm worker
#   media worker:   docker run <image> pnpm media-worker   (capture v2 verify/prepare/cleanup; uses ffmpeg)
#   migrations:     docker run <image> pnpm db:migrate   (run before each release)
#   ops image:      docker build --target ops .  (source + PostgreSQL 16 client tools,
#                   for pnpm ops:backup / psql; the Compose `ops` service)
#   production:     docker-compose.yml (on-prem; docs/deploy.md)
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
COPY apps/media-worker/package.json apps/media-worker/
COPY apps/demo-agent/package.json apps/demo-agent/
COPY apps/sensor-bridge/package.json apps/sensor-bridge/
COPY packages/domain/package.json packages/domain/
COPY packages/providers/package.json packages/providers/
COPY packages/agent-gateway/package.json packages/agent-gateway/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# Operator image (built only with --target ops; the default build target stays
# `runtime`, which the on-prem docker-compose.yml and plain `docker build` use).
# The Compose `ops` service builds this target for backups and drills. It runs tsx scripts
# (migrations, kill switches, backups, metrics) and adds pg_dump/pg_restore/
# psql 16 from the PostgreSQL project's Debian repository: bookworm ships 15,
# which cannot dump a 16 server. Not used to serve traffic.
FROM deps AS ops
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node . .
ENV NODE_ENV=production
USER node
CMD ["sh", "-c", "echo 'culture atlas ops image: run a command, e.g. pnpm ops:kill list'"]

# Build the Next.js app.
FROM deps AS build
COPY . .
RUN pnpm --filter @culture-atlas/web build

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    MEDIA_WORKER_SCRATCH_DIR=/tmp/culture-atlas-media
# ffmpeg/ffprobe for the media worker (Debian bookworm package). The worker only
# advertises video after its startup self-test passes with this exact build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
# On-prem identity mailbox (the spec's file mailbox; no email is sent). A named
# volume mounted here inherits this node-owned, private directory.
RUN mkdir -p /var/lib/culture-atlas/mail \
 && chown node:node /var/lib/culture-atlas/mail \
 && chmod 700 /var/lib/culture-atlas/mail
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "cd apps/web && exec node_modules/.bin/next start -H 0.0.0.0 -p \"${PORT:-3000}\""]
