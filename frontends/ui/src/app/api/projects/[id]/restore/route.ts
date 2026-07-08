/**
 * Restore a soft-deleted project during its grace period.
 * Only valid while the deletion_queue row is still 'pending' —
 * once the purger claims it, data is being destroyed and restore is refused.
 */

import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { deletionQueue, projects } from '@/lib/db/schema'
import { recordAuditEvent } from '@/lib/audit/service'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:manage', {
      includeDeleted: true,
    })

    const db = getDb()
    const restored = await db.transaction(async (tx) => {
      const [entry] = await tx
        .update(deletionQueue)
        .set({ status: 'restored' })
        .where(
          and(
            eq(deletionQueue.entityType, 'project'),
            eq(deletionQueue.entityId, id),
            eq(deletionQueue.status, 'pending'),
            // Only an UN-CLAIMED row is safe to restore. `markFailed` returns a
            // partially-purged row to 'pending' (with claimed_at set); restoring
            // it would resurrect a project whose Chroma/MinIO data was already
            // destroyed — a hollow, corrupt restore. claimed_at IS NULL means the
            // purger has never touched it, so nothing has been destroyed yet.
            isNull(deletionQueue.claimedAt),
          ),
        )
        .returning()

      if (!entry) return false

      await tx
        .update(projects)
        .set({ deletedAt: null })
        .where(eq(projects.id, id))
      return true
    })

    if (!restored) {
      return NextResponse.json(
        {
          error: 'No pending deletion to restore (already purged, or purge in progress).',
          code: 'PURGE_IN_PROGRESS',
        },
        { status: 409 },
      )
    }

    await recordAuditEvent({
      organizationId: session.organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'project.restored',
      targetType: 'project',
      targetId: id,
      request,
    })
    return NextResponse.json({ status: 'restored' })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
