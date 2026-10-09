/**
 * Citation-health diagnostic export — one JSON file per scope, shaped to be
 * handed to a human or an AI agent for root-cause analysis: every flagged
 * turn, the sources retrieval returned, the sources the answer cited, and
 * exactly which citation failed for which reason. Ships a glossary so a reader
 * with no other context can interpret it.
 *
 * Takes the same scope as the dashboard (`from`, `to`, repeatable `org` and
 * `project`; `days` when the range is absent), so the file holds the turns
 * the screen was showing.
 *
 * Platform owners only; tenant admins get 403. Same gate shape as
 * `api/platform/overview/route.ts`.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getCitationExport } from '@/lib/citations/service'
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
    const bundle = await getCitationExport(parsed.scope)

    const fileName = `citation-health-${bundle.scope.from}-to-${bundle.scope.to}.json`
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        // Diagnostics are a point-in-time snapshot; never serve a stale one.
        'Cache-Control': 'no-store',
      },
    })
  },
  { permission: PLATFORM_PERMISSIONS.organizationsView }
)
