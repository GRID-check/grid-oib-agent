/**
 * Citation health — cross-organization citation-quality rollup for the
 * platform owner's dashboard, over the `citation_events` ledger. Platform
 * owners only; tenant admins get 403. Same gate shape as
 * `api/platform/overview/route.ts`.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { getCitationHealth } from '@/lib/citations/service'

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    // Clamped to 1–90 days in the service; an absent or junk value falls back
    // to the default. `Number(null)` is 0, so the param must be read as a
    // string first — otherwise a missing `days` would request a 1-day window.
    const raw = new URL(request.url).searchParams.get('days')
    const days = raw === null ? Number.NaN : Number(raw)
    const snapshot = await getCitationHealth({ days: Number.isFinite(days) ? days : undefined })
    return NextResponse.json(snapshot)
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
