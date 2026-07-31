#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# =============================================================================
# AIQ Blueprint UI - Production Dockerfile
# =============================================================================
#
# Multi-stage build for the Next.js frontend application.
# Public Debian-based Node base (node:22-slim) — no NVIDIA NGC credentials
# needed. Debian (glibc), not Alpine (musl), to avoid native-module surprises.
#
# -----------------------------------------------------------------------------
# BUILD
# -----------------------------------------------------------------------------
#
#   docker build -f deploy/Dockerfile -t aiq-blueprint-ui:latest .
#
# -----------------------------------------------------------------------------
# RUN
# -----------------------------------------------------------------------------
#
# With WorkOS AuthKit authentication:
#
#   docker run -p 3000:3000 \
#     -e BACKEND_URL=http://backend:8000 \
#     -e REQUIRE_AUTH=true \
#     -e WORKOS_CLIENT_ID=client_xxx \
#     -e WORKOS_API_KEY=sk_test_xxx \
#     -e WORKOS_REDIRECT_URI=https://your-domain.com/api/auth/callback \
#     -e WORKOS_COOKIE_PASSWORD=$(openssl rand -hex 32) \
#     aiq-blueprint-ui:latest
#
# Without authentication (development/testing):
#
#   docker run -p 3000:3000 \
#     -e BACKEND_URL=http://backend:8000 \
#     -e REQUIRE_AUTH=false \
#     aiq-blueprint-ui:latest
#
# -----------------------------------------------------------------------------
# ENVIRONMENT VARIABLES (all runtime - no rebuild needed)
# -----------------------------------------------------------------------------
#
# Backend:
#   BACKEND_URL                     - Backend API URL (default: http://localhost:8000)
#
# Authentication:
#   REQUIRE_AUTH                    - Set to 'true' to require WorkOS AuthKit login (default: false)
#
# WorkOS AuthKit (required if REQUIRE_AUTH=true):
#   WORKOS_CLIENT_ID                - WorkOS client ID
#   WORKOS_API_KEY                  - WorkOS API key
#   WORKOS_REDIRECT_URI             - AuthKit callback URL (default: http://localhost:3000/api/auth/callback)
#   WORKOS_COOKIE_PASSWORD          - 32-byte random string used to encrypt the AuthKit session cookie
#
# =============================================================================

# =============================================================================
# Stage 1: Base with Node.js
# =============================================================================
# node:22-slim already ships Node 22 on Debian bookworm; we only add curl for
# the container HEALTHCHECK (ca-certificates is already present in the image).
FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Bun is the INSTALLER and script runner; Node stays the runtime. Copied from
# the official image rather than installed, so the layer is deterministic and
# needs no network step.
#
# Do NOT switch the base to an `oven/bun` image and do NOT invoke bun with
# `--bun`: Turbopack evaluates the Tailwind PostCSS loader in a spawned REAL
# `node` process. A bun-only image has no `node` at all, and `--bun` exports
# NODE_OPTIONS=--bun which that child then rejects. Either way `next build`
# dies with a TurbopackInternalError.
COPY --from=oven/bun:1.3.11-debian /usr/local/bin/bun /usr/local/bin/bun

# =============================================================================
# Stage 2: Dependencies
# =============================================================================
FROM base AS deps

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --ignore-scripts

# =============================================================================
# Stage 3: Builder
# =============================================================================
FROM base AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Defense-in-depth: remove any env files that may have leaked past .dockerignore
RUN rm -f .env .env.local .env.*.local .env.development .env.production 2>/dev/null || true

ENV NEXT_TELEMETRY_DISABLED=1

RUN bun run build

# Remove devDependencies — keeps dev-only packages out of the production image
RUN bun install --frozen-lockfile --production --ignore-scripts

# =============================================================================
# Stage 4: Production Runner
# =============================================================================
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/bun

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/server.js ./server.js
COPY --from=builder --chown=nextjs:nodejs /app/purger ./purger
COPY --from=builder --chown=nextjs:nodejs /app/scheduler ./scheduler
COPY --from=builder --chown=nextjs:nodejs /app/observability ./observability
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

USER nextjs

EXPOSE 3000

# Probe the dependency-free liveness endpoint, not `/`. `/` does a full dynamic
# SSR render and can be slow on a cold container; `/api/healthz` returns a tiny
# 200 as soon as the server is listening. The generous start period covers the
# `drizzle-kit migrate` step that runs before the server starts (see CMD).
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
    CMD curl -f http://localhost:3000/api/healthz || exit 1

CMD ["sh", "-c", "node node_modules/drizzle-kit/bin.cjs migrate && node server.js"]
