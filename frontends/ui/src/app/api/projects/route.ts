/**
 * Projects API
 *
 * Lists and creates projects for the current WorkOS organization.
 * Project access is enforced through WorkOS FGA.
 */

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { getWorkOS } from '@/lib/workos/client'
import { projects } from '@/lib/db/schema'
import { z } from 'zod'

const createProjectSchema = z.object({
  name: z.string().min(1).max(255).trim(),
})

export async function GET(): Promise<Response> {
  const session = await requireAuthorizedSession()
  const db = getDb()

  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, session.organizationId))

  return NextResponse.json(rows)
}

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuthorizedSession()

  const body = await request.json().catch(() => null)
  const parsed = createProjectSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Project name is required and must be 1-255 characters.' },
      { status: 400 },
    )
  }

  const { name } = parsed.data
  const db = getDb()
  const workos = getWorkOS()

  try {
    const [project] = await db
      .insert(projects)
      .values({
        organizationId: session.organizationId,
        name,
        createdBy: session.userId,
        collectionName: `proj_${crypto.randomUUID()}`,
      })
      .returning()

    const resource = await workos.authorization.createResource({
      resourceTypeSlug: 'project',
      externalId: project.id,
      organizationId: session.organizationId,
      name,
    })

    await db
      .update(projects)
      .set({ workosResourceId: resource.id })
      .where(eq(projects.id, project.id))

    await workos.authorization.assignRole({
      organizationMembershipId: session.organizationMembershipId,
      resourceExternalId: project.id,
      resourceTypeSlug: 'project',
      roleSlug: 'project-admin',
    })

    return NextResponse.json(project, { status: 201 })
  } catch (error) {
    console.error('[Projects] Failed to create project:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
