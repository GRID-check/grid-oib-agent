/**
 * Citation-health diagnostic export — one JSON file per window, shaped to be
 * handed to a human or an AI agent for root-cause analysis: every flagged
 * turn, the sources retrieval returned, the sources the answer cited, and
 * exactly which citation failed for which reason. Ships a glossary so a reader
 * with no other context can interpret it.
 *
 * Platform owners only; tenant admins get 403. Same gate shape as
 * `api/platform/overview/route.ts`.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { getCitationExport } from '@/lib/citations/service'
import { parseWindowDaysParam } from '@/lib/citations/window'

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)

    const days = parseWindowDaysParam(new URL(request.url).searchParams.get('days'))
    const bundle = await getCitationExport({ days })

    const fileName = `citation-health-${bundle.windowStart.slice(0, 10)}-to-${bundle.generatedAt.slice(0, 10)}.json`
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        // Diagnostics are a point-in-time snapshot; never serve a stale one.
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
