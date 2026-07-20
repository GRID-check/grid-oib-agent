/**
 * Agent profiler — cross-organization conversation directory for the
 * platform owner's dashboard. Platform owners only; tenant admins get 403.
 * Same gate shape as `api/platform/overview/route.ts`.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { listProfiledConversations } from '@/lib/profiler/service'

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    const query = new URL(request.url).searchParams.get('q')?.trim() || undefined
    const result = await listProfiledConversations(query)
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
