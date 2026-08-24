/**
 * Health Proxy Route
 *
 * Proxies GET /api/health to the backend's /health endpoint.
 * This allows client-side code to check backend health via same-origin
 * requests, which is required in K8s when the backend is not publicly exposed.
 *
 * Intentionally unauthenticated (`publicApiRoute`) — a health probe. It is a
 * transport pass-through, not a data endpoint, so the fetch stays inline.
 */

import { NextResponse } from 'next/server'
import { publicApiRoute } from '@/lib/api/handler'

const getBackendUrl = (): string => {
  const url =
    process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

export const GET = publicApiRoute(
  async () => {
    try {
      const response = await fetch(`${getBackendUrl()}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        return new NextResponse(null, { status: response.status })
      }

      const data = await response.json()
      return NextResponse.json(data)
    } catch {
      return new NextResponse(null, { status: 502 })
    }
  },
  { why: 'a backend health probe: it proxies /health and returns no tenant data' }
)
