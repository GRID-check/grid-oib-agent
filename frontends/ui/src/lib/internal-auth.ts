/**
 * Shared guard for INTERNAL service endpoints (backend → BFF over the compose
 * network). Same token + fail-closed rules as /api/internal/memory:
 * requests authenticate with GRID_INTERNAL_API_TOKEN via the
 * `x-grid-internal-token` header; the well-known dev default is refused
 * outside dev environments; an unconfigured token disables the endpoint.
 */

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

export const INTERNAL_TOKEN_HEADER = 'x-grid-internal-token'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const DEV_APP_ENVS = new Set(['development', 'dev', 'local'])

function tokensMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isDevEnvironment(): boolean {
  const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'production').toLowerCase()
  return DEV_APP_ENVS.has(env)
}

/**
 * Returns a rejection Response, or null when the request is authorized.
 * Usage: `const denied = requireInternalToken(request); if (denied) return denied`
 */
export function requireInternalToken(request: Request, label: string): Response | null {
  const expectedToken = process.env.GRID_INTERNAL_API_TOKEN
  if (!expectedToken) {
    console.error(`[${label}] GRID_INTERNAL_API_TOKEN is not configured — rejecting`)
    return NextResponse.json({ error: 'Internal API disabled' }, { status: 503 })
  }
  if (expectedToken === DEV_DEFAULT_TOKEN && !isDevEnvironment()) {
    console.error(
      `[${label}] GRID_INTERNAL_API_TOKEN is the well-known dev default in a non-dev environment — refusing to serve.`,
    )
    return NextResponse.json({ error: 'Internal API disabled' }, { status: 503 })
  }
  if (!tokensMatch(request.headers.get(INTERNAL_TOKEN_HEADER), expectedToken)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}
