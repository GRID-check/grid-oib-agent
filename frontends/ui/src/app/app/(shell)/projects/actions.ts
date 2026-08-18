'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { createProject as createProjectInOrg } from '@/lib/projects/service'

export interface CreateProjectState {
  error?: string
}

/**
 * Create a project from the projects-page form.
 *
 * Server actions are transport, exactly like route handlers: open a scope,
 * resolve the session, validate the input shape, call the service, redirect.
 * This one used to re-implement the whole of `projects/service.ts#createProject`
 * — the same insert, the same WorkOS resource, the same role assignment, the
 * same audit event — which meant the two copies could (and did) drift.
 *
 * A server action gets no route factory, so like a page it opens its own tenant
 * slot; without one every query underneath runs with no context and fails
 * closed under row-level security.
 */
export async function createProject(
  _prevState: CreateProjectState,
  formData: FormData
): Promise<CreateProjectState> {
  const projectId = await withPageSession(async (session) => {
    const name = formData.get('name')
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 255) {
      return { error: 'Project name is required and must be 1-255 characters.' } as const
    }

    try {
      const project = await createProjectInOrg(session, { name: name.trim() })
      return { id: project.id } as const
    } catch (error) {
      console.error('[createProject] Failed to create project:', error)
      return { error: error instanceof Error ? error.message : 'Unknown error' } as const
    }
  })

  if ('error' in projectId) return { error: projectId.error }

  // `'/app', 'layout'` rather than `'/app/projects', 'page'`.
  //
  // The rail's project list is now resolved in the `(shell)` LAYOUT, not in the
  // page — that is what makes it persist across navigation. The flip side is
  // that a page-scoped revalidation no longer reaches it: the redirect below
  // walks to a route whose shell segment is already in the client router cache,
  // so Next would reuse the cached layout payload and the switcher would open
  // without the project that was just created. Revalidating the layout marks
  // that segment stale too, so the first navigation after a create refetches
  // the rail. (Renames go the other way — `project-rename-button.tsx` calls
  // `router.refresh()`, which refetches the current route INCLUDING its
  // layouts, so the new name reaches the switcher without a server action.)
  revalidatePath('/app', 'layout')
  // Land new projects directly in intake: the brief is what makes Piloti's answers
  // (and the applicable-standards panel) useful, so setup flows straight into it.
  // Outside the scope on purpose: `redirect()` reports itself by throwing, and a
  // throw is not something the tenant slot should be unwinding through.
  redirect(`/app/projects/${projectId.id}/intake`)
}
