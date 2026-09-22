/**
 * Liveness probe for the frontend web server.
 *
 * Deliberately dependency-free: it does NOT touch the backend, the database,
 * S3/SeaweedFS, or the WorkOS session. It answers one question only — "is this
 * Next.js server process up and serving HTTP?" — which is exactly what a
 * container / Coolify / Traefik health check needs.
 *
 * This is intentionally distinct from `/api/health`, which proxies the backend
 * agent's `/health` and therefore reports 502 whenever the backend is down.
 * Using that as the *frontend's* health check makes a perfectly healthy web
 * container look unhealthy (and stops Traefik from routing to it) any time the
 * backend is slow to boot. Keep the two separate.
 *
 * Intentionally unauthenticated (`publicApiRoute`) — a liveness probe.
 */

import { NextResponse } from 'next/server'
import { publicApiRoute } from '@/lib/api/handler'
import { deployedSha } from '@/lib/boot'

// Never statically cached — always executes so the probe reflects a live server.
export const dynamic = 'force-dynamic'

export const GET = publicApiRoute(
  // `sha` is the deployed commit (`GRID_GIT_SHA`, stamped into the image at
  // build time), or `unknown`. It is here rather than only in the boot log
  // because a pilot report arrives days later, by which time the log line has
  // rotated: this answers "what is that deployment running" over HTTP, from
  // outside, with no shell. It reveals nothing a probe should not — a commit
  // sha of a private repository is not a credential and not tenant data — and
  // this route stays dependency-free, reading one env var and nothing else.
  // The backend's own sha comes back through `/api/health`, which proxies it.
  async () =>
    NextResponse.json(
      { status: 'ok', sha: deployedSha() },
      { headers: { 'Cache-Control': 'no-store' } }
    ),
  { why: 'a dependency-free liveness probe: it reads nothing and returns a constant' }
)
