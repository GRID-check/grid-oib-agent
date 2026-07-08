/** Version history of the org's model configuration. Org admins only. */

import { NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { canManageModels } from '@/lib/authz/organizations'
import { getOrgModelConfig, listVersions } from '@/lib/model-config/service'

export async function GET(): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    if (!canManageModels(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const [versions, config] = await Promise.all([
      listVersions(session.organizationId),
      getOrgModelConfig(session.organizationId),
    ])
    return NextResponse.json({
      versions,
      activeVersionId: config.activeVersion?.id ?? null,
    })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
