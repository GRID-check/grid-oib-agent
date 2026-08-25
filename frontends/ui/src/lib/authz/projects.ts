import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { findProjectTenancy } from '@/lib/projects/repository'
import { hasPermission, ORG_PERMISSIONS } from './permissions'
import { checkResourcePermission } from './resource-check'

export type ProjectPermission =
  | 'project:view'
  | 'project:edit'
  | 'project:manage'
  | 'project:chat'
  | 'project:documents:write'
  | 'project:memory:write'
  | 'project:members:manage'
  | 'project:skills:manage'

/**
 * The DERIVED capability ladder — what this caller can do in the project, not
 * which role slug WorkOS assigned them.
 *
 * Deliberately narrower than the catalog's set of assignable project roles
 * (`ProjectMemberRole` in `lib/projects/members-service.ts`). `project-contributor`
 * is a real, assignable role, but it maps onto the same rung as
 * `project-viewer` everywhere the ladder is consumed — both read, neither
 * writes — and deriving it would cost a third concurrent FGA check on every
 * project access to tell two identical answers apart. Chat access is checked as
 * the `project:chat` permission where it matters, which is the honest place for
 * it; see {@link requireProjectAccess}.
 */
export type ProjectRole = 'project-viewer' | 'project-editor' | 'project-admin'

/**
 * Authorize a session against a project and derive its effective role.
 *
 * The FGA round-trip (with its optional short-TTL cache and its timing
 * instrumentation) lives in `./resource-check`, shared with the skill tier so
 * the two can never drift apart. See that module for the caching tradeoff.
 *
 * Denials throw {@link NotFoundError} (message "Not found") so responses
 * never confirm the existence of projects the caller may not see.
 */
export async function requireProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  /**
   * The permission to require, or an ANY-OF list — holding any ONE of them is
   * enough. Order carries no meaning; the derived role is read from the
   * permissions the caller actually holds, not from the list's first entry.
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

  // The org-wide project bypass (but never the tenancy check above).
  //
  // Gated on the PERMISSION `org:projects:administer`, not on the role slug
  // `admin`. Keying it on the name was the single place the "permission-driven,
  // never role-name driven" contract broke: a custom role holding every `org:*`
  // permission reached no project at all, while any role that merely happened to
  // be named `admin` administered every project in the tenant while holding
  // nothing. `hasPermission`'s bounded catalog implication keeps existing admin
  // sessions working, because the catalog grants Admin this permission — so no
  // one has to re-log-in for the fix.
  //
  // Surfaced as the named `org-admin-bypass` rule when routed through
  // `./decide`, so the bypass is visible in a decision rather than implicit.
  if (hasPermission(session, ORG_PERMISSIONS.projectsAdminister)) {
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
  // The two extra checks are skipped when the any-of list already covers them —
  // their answer is then read out of `granted` below instead.
  const [granted, extraManage, extraEdit] = await Promise.all([
    Promise.all(accepted.map(check)),
    accepted.includes('project:manage') ? Promise.resolve(null) : check('project:manage'),
    accepted.includes('project:edit') ? Promise.resolve(null) : check('project:edit'),
  ])

  // Any-of: holding the narrow permission OR the legacy umbrella is enough.
  if (!granted.some(Boolean)) {
    throw new NotFoundError()
  }

  // Which of the accepted permissions the caller ACTUALLY holds — not merely
  // which ones were asked about. Deriving the role from `accepted` was wrong the
  // moment a list had more than one member whose grant differed: with
  // `['project:members:manage', 'project:manage']` a real project admin came back
  // as an editor, because the skipped `project:manage` check fell back to
  // comparing against `accepted[0]`, a different slug.
  const held = new Set(accepted.filter((_, index) => granted[index]))

  if (extraManage ?? held.has('project:manage')) return { role: 'project-admin' }

  // The editor rung is "holds a WRITE permission", not "holds `project:edit`".
  // After the ADR-0038 split the umbrella is one of three ways to write, and a
  // role built the way the catalog now recommends holds only the narrow ones —
  // reading such a caller as a viewer would make them a mere reader on every
  // shared thread in a project whose corpus they can change.
  const writes = extraEdit ?? held.has('project:edit')
  if (writes || held.has('project:documents:write') || held.has('project:memory:write')) {
    return { role: 'project-editor' }
  }
  return { role: 'project-viewer' }
}
