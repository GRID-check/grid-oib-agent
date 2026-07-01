// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Project detail API
 *
 * Reads, updates, and deletes a single project.
 */

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { getWorkOS } from '@/lib/workos/client'
import { projects } from '@/lib/db/schema'
import { z } from 'zod'

const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).trim(),
})

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const db = getDb()
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)

  if (!project) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json(project)
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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
    .where(eq(projects.id, id))
    .returning()

  if (!project) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json(project)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:manage')

  const workos = getWorkOS()
  const db = getDb()

  try {
    await workos.authorization.deleteResourceByExternalId({
      organizationId: session.organizationId,
      resourceTypeSlug: 'project',
      externalId: id,
      cascadeDelete: true,
    })

    await db.delete(projects).where(eq(projects.id, id))

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error('[Projects] Failed to delete project:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
