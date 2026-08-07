'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { createProject as createProjectInOrg } from '@/lib/projects/service'

export interface CreateProjectState {
  error?: string
}

/**
 * Create a project from the projects-page form.
 *
 * Server actions are transport, exactly like route handlers: resolve the
 * session, validate the input shape, call the service, redirect. This one used
 * to re-implement the whole of `projects/service.ts#createProject` — the same
 * insert, the same WorkOS resource, the same role assignment, the same audit
 * event — which meant the two copies could (and did) drift: the service gained
 * a tenant-scoped repository insert while this copy kept its own `getDb()` call
 * and, once row-level security was enforced, no tenant context to run it in.
 */
export async function createProject(_prevState: CreateProjectState, formData: FormData): Promise<CreateProjectState> {
  const session = await requireAuthorizedPageSession()

  const name = formData.get('name')
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 255) {
    return { error: 'Project name is required and must be 1-255 characters.' }
  }

  let projectId: string

  try {
    const project = await createProjectInOrg(session, { name: name.trim() })
    projectId = project.id
  } catch (error) {
    console.error('[createProject] Failed to create project:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { error: message }
  }

  revalidatePath('/app/projects')
  // Land new projects directly in intake: the brief is what makes Piloti's answers
  // (and the applicable-standards panel) useful, so setup flows straight into it.
  redirect(`/app/projects/${projectId}/intake`)
}
