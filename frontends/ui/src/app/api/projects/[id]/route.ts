/**
 * Project detail API
 *
 * Reads, updates, and deletes a single project.
 */

import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { deletionQueue, projects } from '@/lib/db/schema'
import { computePurgeAfter, projectGraceDays } from '@/lib/deletion/policy'
import { z } from 'zod'

const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).trim(),
})

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:view')

    const db = getDb()
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

    if (!project || project.deletedAt) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(project)
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:manage')

    const body = await request.json().catch(() => null)
    const parsed = updateProjectSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Project name is required and must be 1-255 characters.' },
        { status: 400 },
      )
    }

    const db = getDb()
    const [project] = await db
      .update(projects)
      .set({ name: parsed.data.name })
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
      .returning()

    if (!project) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(project)
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}

const deleteProjectSchema = z.object({
  confirmName: z.string().min(1),
})

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:manage')

    const body = await request.json().catch(() => null)
    const parsed = deleteProjectSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Type the project name to confirm deletion.' },
        { status: 400 },
      )
    }

    const db = getDb()
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

    if (!project || project.deletedAt) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (parsed.data.confirmName !== project.name) {
      return NextResponse.json(
        { error: 'Project name does not match.' },
        { status: 400 },
      )
    }

    const now = new Date()
    const purgeAfter = computePurgeAfter(now, projectGraceDays())

    // Soft delete + enqueue atomically. The purger hard-deletes every store
    // after the grace period; nothing is destroyed here.
    await db.transaction(async (tx) => {
      await tx.update(projects).set({ deletedAt: now }).where(eq(projects.id, id))
      await tx
        .insert(deletionQueue)
        .values({
          entityType: 'project',
          entityId: id,
          displayName: project.name,
          organizationId: project.organizationId,
          requestedBy: session.userId,
          purgeAfter,
          payload: { collectionName: project.collectionName },
        })
        .onConflictDoNothing()
    })

    return NextResponse.json(
      { status: 'pending', purgeAfter: purgeAfter.toISOString() },
      { status: 202 },
    )
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
