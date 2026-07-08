/**
 * Lists pending/failed deletions for the current organization (org admins).
 * Powers the "Recently deleted" UI; failed rows surface stuck purges.
 */

import { NextResponse } from 'next/server'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { canManageCompliance } from '@/lib/authz/organizations'
import { getDb } from '@/lib/db'
import { deletionQueue } from '@/lib/db/schema'

export async function GET(): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()

    if (!canManageCompliance(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const db = getDb()
    const rows = await db
      .select({
        id: deletionQueue.id,
        entityType: deletionQueue.entityType,
        entityId: deletionQueue.entityId,
        displayName: deletionQueue.displayName,
        requestedBy: deletionQueue.requestedBy,
        requestedAt: deletionQueue.requestedAt,
        purgeAfter: deletionQueue.purgeAfter,
        status: deletionQueue.status,
        lastError: deletionQueue.lastError,
      })
      .from(deletionQueue)
      .where(
        and(
          eq(deletionQueue.organizationId, session.organizationId),
          inArray(deletionQueue.status, ['pending', 'failed']),
        ),
      )
      .orderBy(desc(deletionQueue.requestedAt))

    return NextResponse.json(rows)
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
