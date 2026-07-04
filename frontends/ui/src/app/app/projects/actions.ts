'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { getWorkOS } from '@/lib/workos/client'
import { projects } from '@/lib/db/schema'

export interface CreateProjectState {
  error?: string
}

export async function createProject(_prevState: CreateProjectState, formData: FormData): Promise<CreateProjectState> {
  const session = await requireAuthorizedSession()

  const name = formData.get('name')
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 255) {
    return { error: 'Project name is required and must be 1-255 characters.' }
  }

  const trimmed = name.trim()
  const db = getDb()
  const workos = getWorkOS()

  let projectId: string

  try {
    const [project] = await db
      .insert(projects)
      .values({
        organizationId: session.organizationId,
        name: trimmed,
        createdBy: session.userId,
        collectionName: `proj_${crypto.randomUUID()}`,
      })
      .returning()

    projectId = project.id

    const resource = await workos.authorization.createResource({
      resourceTypeSlug: 'project',
      externalId: project.id,
      organizationId: session.organizationId,
      name: trimmed,
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
  } catch (error) {
    console.error('[createProject] Failed to create project:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { error: message }
  }

  revalidatePath('/app/projects')
  // Land new projects directly in intake: the brief is what makes Grid's answers
  // (and the applicable-standards panel) useful, so setup flows straight into it.
  redirect(`/app/projects/${projectId}/intake`)
}
