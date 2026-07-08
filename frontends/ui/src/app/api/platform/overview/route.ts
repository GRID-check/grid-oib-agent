/**
 * Platform overview — cross-organization directory + stats for the platform
 * owner's dashboard (ADR-0016). Platform owners only; tenant admins get 403.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { getPlatformOverview } from '@/lib/platform/service'
import { eurPerUsd } from '@/lib/budgets/service'

export async function GET(): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    const overview = await getPlatformOverview()
    return NextResponse.json({ ...overview, eurPerUsd: eurPerUsd() })
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
