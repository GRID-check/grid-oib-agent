/**
 * Platform norm-registry verification — check a pointer against RIS and return
 * candidate matches for the admin to pick from. Platform owners only.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { verifyNormPointer } from '@/lib/norms/service'
import { verifyNormRequestSchema } from '@/lib/norms/schemas'

export const POST = platformApiRoute(
  async ({ request }) => {
    const json = await request.json().catch(() => null)
    const parsed = verifyNormRequestSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Ungültige Verifizierungsanfrage',
          code: 'BAD_REQUEST',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      )
    }

    const result = await verifyNormPointer(parsed.data)
    return NextResponse.json(result)
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
