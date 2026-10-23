# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions

# syntax=docker/dockerfile:1
#
# OpenMasjid Students — multi-stage, multi-arch (amd64 + arm64).
# The JS build stage runs on the native BUILD platform (fast, arch-independent
# output); the runtime stage runs as the TARGET arch, where `npm ci` pulls the
# correct prebuilt native binaries (e.g. better-sqlite3) for that architecture.
# This is an npm-workspaces monorepo (packages/server + packages/web).

# ---- Build web (Vite) + server (tsc) -> dist --------------------------------
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app
# Copy the workspace manifests first for a cached dependency layer.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
# Now the sources, then build both workspaces (web -> dist, server -> dist).
COPY . .
RUN npm run build

# ---- Runtime (target architecture) ------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="OpenMasjid Students" \
      org.opencontainers.image.description="Self-hosted, madrasa-first tuition & fee management with a real student record and admissions — an OpenMasjidOS app." \
      org.opencontainers.image.source="https://github.com/OpenMasjid-Solutions/OpenMasjidStudents" \
      org.opencontainers.image.licenses="AGPL-3.0"

# ca-certificates: outbound HTTPS to api.stripe.com + the OS Fabric. tini: reap
# children + forward signals so the container stops fast and cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Production deps only, installed on the TARGET arch so native modules
# (better-sqlite3) resolve the right prebuilt binary. Uses the root lockfile, so
# the install is deterministic; the web workspace's runtime deps come along too
# (a small, acceptable size cost for a single deterministic `npm ci`).
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev

# Server bundle + its committed Drizzle migrations, and the built web UI.
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/drizzle ./packages/server/drizzle
COPY --from=build /app/packages/web/dist ./public

ENV PORT=8080 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public
EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
