/**
 * Citation health — cross-organization citation-quality rollup for the
 * platform owner's dashboard, over the `citation_events` ledger. Platform
 * owners only; tenant admins get 403. Same gate shape as
 * `api/platform/overview/route.ts`.
 *
 * Read in the Answer-quality scope (`lib/quality/scope.ts`): `from`/`to` (UTC
 * days, inclusive), repeatable `org` and `project`. A malformed or oversized
 * range is a 400, never a silently different window; without `from`/`to` the
 * older `days=7|30|90` still works.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getCitationHealth } from '@/lib/citations/service'
import { parseQualityScopeStrict } from '@/lib/quality/scope'

export const GET = platformApiRoute(
  async ({ request }) => {
    const parsed = parseQualityScopeStrict(new URL(request.url).searchParams)
    if (!parsed.ok) {
      return NextResponse.json(
        { error: 'Invalid scope', code: 'BAD_REQUEST', details: { scope: parsed.error } },
        { status: 400 }
      )
    }
    const snapshot = await getCitationHealth(parsed.scope)
    return NextResponse.json(snapshot)
  },
  { permission: PLATFORM_PERMISSIONS.organizationsView }
)
