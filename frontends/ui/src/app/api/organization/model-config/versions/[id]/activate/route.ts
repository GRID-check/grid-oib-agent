/**
 * Activate (roll back to) an existing configuration version, or deactivate
 * all overrides with the special id 'none'. Org admins only.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { canManageModels } from '@/lib/authz/organizations'
import { activateVersion } from '@/lib/model-config/service'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    if (!canManageModels(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const { id } = await params
    const versionId = id === 'none' ? null : id
    if (versionId !== null && !/^[0-9a-f-]{36}$/i.test(versionId)) {
      return NextResponse.json({ error: 'Invalid version id' }, { status: 400 })
    }
    const version = await activateVersion({
      organizationId: session.organizationId,
      versionId,
      actorUserId: session.userId,
    })
    return NextResponse.json({ activeVersion: version })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
