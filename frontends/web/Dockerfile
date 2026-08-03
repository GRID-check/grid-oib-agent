# =============================================================================
# Piloti Landing + Blog (Astro) - Production Dockerfile
# =============================================================================
#
# Multi-stage build for the Astro landing site with the Node standalone
# adapter. Public Debian-based Node base (node:22-slim) - no NVIDIA NGC
# credentials needed. Debian (glibc), not Alpine (musl), to avoid
# native-module surprises (sharp).
#
# The Astro client-dir path is baked into dist/server/entry.mjs at build
# time, so the site MUST be built inside this container (or a container with
# the same WORKDIR layout) - dist/ is copied wholesale from the builder.
#
# Build-time args (baked into the static site; see astro.config.mjs):
#   PUBLIC_APP_URL  - Where the app lives (nav "Anmelden" link). Default
#                     https://app.dev.piloti.at (dev `latest` image).
#   PUBLIC_SITE_URL - Canonical site URL for sitemap/OG metadata. Default
#                     https://dev.piloti.at (dev `latest` image).
#   Prod tags must be rebuilt with the prod overrides:
#     --build-arg PUBLIC_APP_URL=https://app.piloti.at \
#     --build-arg PUBLIC_SITE_URL=https://piloti.at
#
# Runtime:
#   docker run -p 4321:4321 \
#     -e HOST=0.0.0.0 -e PORT=4321 \
#     ghcr.io/grid-check/grid-oib-web:latest
#
# =============================================================================

# =============================================================================
# Stage 1: Base with Node.js
# =============================================================================
# node:22-slim already ships Node 22 on Debian bookworm; curl is added for the
# container HEALTHCHECK (ca-certificates is already present in the image).
FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Stage 2: Dependencies
# =============================================================================
FROM base AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --ignore-scripts

# =============================================================================
# Stage 3: Builder
# =============================================================================
FROM base AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Defense-in-depth: remove any env files that may have leaked past .dockerignore
RUN rm -f .env .env.local .env.*.local .env.development .env.production 2>/dev/null || true

# Site URLs are baked into the prerendered HTML at build time.
ARG PUBLIC_APP_URL
ARG PUBLIC_SITE_URL
ENV PUBLIC_APP_URL=$PUBLIC_APP_URL
ENV PUBLIC_SITE_URL=$PUBLIC_SITE_URL
ENV ASTRO_TELEMETRY_DISABLED=1

RUN npm run build

# Remove devDependencies - keeps dev-only packages out of the production image
# (tailwind, check tooling, ...). sharp stays (image handling).
RUN npm prune --omit=dev

# =============================================================================
# Stage 4: Production Runner
# =============================================================================
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV ASTRO_TELEMETRY_DISABLED=1
# Overridden at runtime by the Kubernetes deployment via HOST/PORT env.
ENV HOST=0.0.0.0
ENV PORT=4321

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs piloti \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder --chown=piloti:nodejs /app/dist ./dist
COPY --from=builder --chown=piloti:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=piloti:nodejs /app/package.json ./package.json

USER piloti

EXPOSE 4321

# `/` is a prerendered static HTML file - a cheap, dependency-free probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD curl -sf http://localhost:4321/ || exit 1

CMD ["node", "dist/server/entry.mjs"]
