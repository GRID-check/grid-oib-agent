import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { findProjectTenancy } from '@/lib/projects/repository'
import { checkResourcePermission } from './resource-check'

export type ProjectPermission =
  | 'project:view'
  | 'project:edit'
  | 'project:manage'
  | 'project:chat'
  | 'project:documents:write'
  | 'project:memory:write'
  | 'project:members:manage'
  | 'project:workflows:manage'

export type ProjectRole =
  | 'project-viewer'
  | 'project-contributor'
  | 'project-editor'
  | 'project-admin'

/**
 * Authorize a session against a project and derive its effective role.
 *
 * The FGA round-trip (with its optional short-TTL cache and its timing
 * instrumentation) lives in `./resource-check`, shared with the workflow tier so
 * the two can never drift apart. See that module for the caching tradeoff.
 *
 * Denials throw {@link NotFoundError} (message "Not found") so responses
 * never confirm the existence of projects the caller may not see.
 */
export async function requireProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  /**
   * The permission to require, or an ANY-OF list whose FIRST entry is the
   * canonical one.
   *
   * The list form exists for the ADR-0038 split of the old `project:edit`
   * umbrella into `project:documents:write` / `project:memory:write`. The
   * built-in editor and admin roles hold both the narrow permission and the
   * umbrella, but a CUSTOM role provisioned before the split may hold only
   * `project:edit` — passing `['project:documents:write', 'project:edit']` keeps
   * that grant working while new roles can be given just the narrow one.
   */
  permission: ProjectPermission | readonly ProjectPermission[] = 'project:view',
  options: { includeDeleted?: boolean } = {}
): Promise<{ role: ProjectRole }> {
  const accepted: readonly ProjectPermission[] = Array.isArray(permission)
    ? permission
    : [permission as ProjectPermission]
  const canonical = accepted[0]
  // Verify the project belongs to the current org (and is not soft-deleted,
  // unless the caller explicitly needs deleted projects, e.g. restore).
  // This tenancy check runs for EVERYONE — the org-admin bypass below only
  // skips the per-project FGA checks. Bypassing it for admins let an org-A
  // admin act on an org-B project by id (routes query by id downstream).
  const project = await findProjectTenancy(projectId)

  if (
    !project ||
    project.organizationId !== session.organizationId ||
    (project.deletedAt && !options.includeDeleted)
  ) {
    throw new NotFoundError()
  }

  // Org admins bypass per-project FGA checks (but never the tenancy check).
  // Surfaced as the named `org-admin-bypass` rule when routed through
  // `./decide`, so the bypass is visible in a decision rather than implicit.
  if (session.role === 'admin') {
    return { role: 'project-admin' }
  }

  const check = (permissionSlug: ProjectPermission) =>
    checkResourcePermission({
      organizationMembershipId: session.organizationMembershipId,
      permissionSlug,
      resourceExternalId: projectId,
      resourceTypeSlug: 'project',
    })

  // One round of concurrent checks rather than three sequential ones: the
  // requested permission gates access; manage/edit only refine the derived role.
  const [granted, isAdmin, isEditor] = await Promise.all([
    Promise.all(accepted.map(check)),
    accepted.includes('project:manage') ? Promise.resolve(null) : check('project:manage'),
    accepted.includes('project:edit') ? Promise.resolve(null) : check('project:edit'),
  ])

  // Any-of: holding the narrow permission OR the legacy umbrella is enough.
  if (!granted.some(Boolean)) {
    throw new NotFoundError()
  }

  if (isAdmin ?? canonical === 'project:manage') return { role: 'project-admin' }
  if (isEditor ?? accepted.includes('project:edit')) return { role: 'project-editor' }
  return { role: 'project-viewer' }
}
