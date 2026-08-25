/**
 * Platform norm-registry API — read the curated catalog and persist edits.
 * Platform owners only. The whole registry is written at once under the held
 * optimistic-concurrency version; backend 409/422/400 statuses are relayed
 * faithfully so the client can react (reload prompt / validation message).
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getNormRegistry, putNormRegistry } from '@/lib/norms/service'
import { putNormRegistryBodySchema } from '@/lib/norms/schemas'

export const GET = platformApiRoute(
  async () => {
    const registry = await getNormRegistry()
    return NextResponse.json(registry)
  },
  { permission: PLATFORM_PERMISSIONS.settingsView }
)

export const PUT = platformApiRoute(
  async ({ request, session }) => {
    const json = await request.json().catch(() => null)
    const parsed = putNormRegistryBodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Ungültige Registry', code: 'BAD_REQUEST', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const result = await putNormRegistry(session, parsed.data, request)
    return NextResponse.json(result)
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
