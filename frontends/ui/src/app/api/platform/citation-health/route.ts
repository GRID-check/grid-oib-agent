/**
 * Citation health — cross-organization citation-quality rollup for the
 * platform owner's dashboard, over the `citation_events` ledger. Platform
 * owners only; tenant admins get 403. Same gate shape as
 * `api/platform/overview/route.ts`.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { getCitationHealth } from '@/lib/citations/service'
import { parseWindowDaysParam } from '@/lib/citations/window'

export const GET = platformApiRoute(async ({ request }) => {
  // Clamped to 1–90 days in the service; absent, blank, non-numeric and
  // non-positive values all fall through to the default window.
  const days = parseWindowDaysParam(new URL(request.url).searchParams.get('days'))
  const snapshot = await getCitationHealth({ days })
  return NextResponse.json(snapshot)
})
