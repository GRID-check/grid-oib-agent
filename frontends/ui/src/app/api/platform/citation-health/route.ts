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
import { parseWindowDaysParam } from '@/lib/citations/window'

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    // Clamped to 1–90 days in the service; absent, blank, non-numeric and
    // non-positive values all fall through to the default window.
    const days = parseWindowDaysParam(new URL(request.url).searchParams.get('days'))
    const snapshot = await getCitationHealth({ days })
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
