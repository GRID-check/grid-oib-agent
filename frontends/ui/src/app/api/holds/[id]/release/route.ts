import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { canManageCompliance } from '@/lib/authz/organizations'
import { getDb } from '@/lib/db'
import { legalHolds } from '@/lib/db/schema'
import { recordAuditEvent } from '@/lib/audit/service'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    if (!canManageCompliance(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const { id } = await params

    const db = getDb()
    const [hold] = await db
      .update(legalHolds)
      .set({ releasedAt: new Date() })
      .where(
        and(
          eq(legalHolds.id, id),
          eq(legalHolds.organizationId, session.organizationId),
          isNull(legalHolds.releasedAt),
        ),
      )
      .returning()

    if (!hold) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    await recordAuditEvent({
      organizationId: session.organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'compliance.hold.released',
      targetType: 'legal_hold',
      targetId: hold.id,
      metadata: { entityType: hold.entityType, entityId: hold.entityId },
      request,
    })
    return NextResponse.json(hold)
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
