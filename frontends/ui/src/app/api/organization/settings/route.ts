/**
 * Organization settings API (Grid-side org record).
 *
 * GET  — any member may read their org's settings.
 * PUT  — org admins only; merges the provided fields.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isOrgAdmin } from '@/lib/authz/organizations'
import { getOrgSettings, updateOrgSettings } from '@/lib/organizations/service'
import { recordAuditEvent } from '@/lib/audit/service'
import { locales } from '@/i18n/config'

export async function GET(): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const settings = await getOrgSettings(session.organizationId)
    return NextResponse.json({ settings })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}

const putSchema = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  defaultLocale: z.enum(locales).optional(),
  settings: z.record(z.unknown()).optional(),
})

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()

    if (!isOrgAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    const parsed = putSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid settings payload' }, { status: 400 })
    }

    const settings = await updateOrgSettings(session.organizationId, parsed.data)
    await recordAuditEvent({
      organizationId: session.organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'org.settings.updated',
      targetType: 'organization',
      targetId: session.organizationId,
      metadata: { fields: Object.keys(parsed.data).join(',') },
      request,
    })
    return NextResponse.json({ settings })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
