/**
 * Platform maintenance — the kill switch: interrupt every running deep research
 * across every organization, stop its worker, and close its run as
 * `interrupted` (`lib/runs/kill-all.ts`). Platform owners only.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { killAllActiveRuns } from '@/lib/runs/kill-all'

export const POST = platformApiRoute(
  async ({ session }) => {
    // No audit schema exists for this action yet, so the log is the record of
    // who pressed it.
    console.warn('[Platform Maintenance] kill switch pressed by user', session.userId)
    const result = await killAllActiveRuns()
    console.warn('[Platform Maintenance] kill switch result', JSON.stringify(result))
    return NextResponse.json(result)
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
