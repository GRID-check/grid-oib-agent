/**
 * Restore a soft-deleted project during its grace period.
 * Only valid while the deletion_queue row is still 'pending' —
 * once the purger claims it, data is being destroyed and restore is refused.
 */

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { deletionQueue, projects } from '@/lib/db/schema'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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
      { error: 'No pending deletion to restore (already purged or purging).' },
      { status: 409 },
    )
  }

  return NextResponse.json({ status: 'restored' })
}
