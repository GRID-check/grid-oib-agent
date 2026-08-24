/**
 * Agent profiler — cross-organization conversation directory for the
 * platform owner's dashboard. Platform owners only; tenant admins get 403.
 * Same gate shape as `api/platform/overview/route.ts`.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { listProfiledConversations } from '@/lib/profiler/service'

export const GET = platformApiRoute(async ({ request }) => {
  const query = new URL(request.url).searchParams.get('q')?.trim() || undefined
  const result = await listProfiledConversations(query)
  return NextResponse.json(result)
})
