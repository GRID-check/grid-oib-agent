/**
 * Platform overview — cross-organization directory + stats for the platform
 * owner's dashboard (ADR-0016). Platform owners only; tenant admins get 403.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getPlatformOverview } from '@/lib/platform/service'
import { eurPerUsd } from '@/lib/budgets/service'

export const GET = platformApiRoute(
  async () => {
    const overview = await getPlatformOverview()
    return NextResponse.json({ ...overview, eurPerUsd: eurPerUsd() })
  },
  { permission: PLATFORM_PERMISSIONS.organizationsView }
)
