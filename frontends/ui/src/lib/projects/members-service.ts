/**
 * Project members service — the WorkOS FGA roster and role assignments for a
 * project. Owns authorization (`project:manage` for every operation) and the
 * audit trail for access-control changes. Route handlers stay thin: they
 * validate input shape and delegate here.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { requireProjectAccess } from '@/lib/authz/projects'
import { recordAuditEvent } from '@/lib/audit/service'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findProjectWorkosResourceId } from './repository'

export type ProjectMemberRole = 'project-viewer' | 'project-editor' | 'project-admin'

const PROJECT_ADMIN_ROLE_SLUG = 'project-admin'

/** Machine-readable marker so the client can localize the last-admin block. */
const LAST_ADMIN_DETAILS = { reason: 'last-admin' } as const

/**
 * The distinct organization-membership ids that currently hold `project-admin`
 * on a resource, derived from the FGA role assignments the caller already
 * listed. A `Set` because a membership can appear more than once (e.g. direct
 * plus group-derived) and each counts as a single admin.
 */
function adminMembershipIds(
  assignments: Array<{ organizationMembershipId: string; role: { slug: string } }>,
): Set<string> {
  return new Set(
    assignments
      .filter((assignment) => assignment.role.slug === PROJECT_ADMIN_ROLE_SLUG)
      .map((assignment) => assignment.organizationMembershipId),
  )
}

/**
 * Last-admin invariant. A role change or removal that strips `project-admin`
 * from `targetMembershipId` is rejected when no OTHER membership would still be
 * an admin — a project must never be left with zero admins and no in-app way to
 * recover. `willRemainAdmin` is true only when the pending change re-grants
 * `project-admin` to the same target. Covers both self-demotion and demoting
 * the only other admin. Cheap: it reuses the assignment list already fetched,
 * adding no WorkOS round-trip.
 */
function assertNotLastAdmin(
  assignments: Array<{ organizationMembershipId: string; role: { slug: string } }>,
  targetMembershipId: string,
  willRemainAdmin: boolean,
): void {
  if (willRemainAdmin) return
  const admins = adminMembershipIds(assignments)
  if (!admins.has(targetMembershipId)) return
  const otherAdmins = [...admins].filter((id) => id !== targetMembershipId)
  if (otherAdmins.length === 0) {
    throw new ConflictError(
      'This project must keep at least one admin. Assign another admin before removing this one.',
      LAST_ADMIN_DETAILS,
    )
  }
}

const PROJECT_ROLE_BY_PERMISSION: Array<{
  permissionSlug: 'project:view' | 'project:edit' | 'project:manage'
  role: ProjectMemberRole
}> = [
  { permissionSlug: 'project:view', role: 'project-viewer' },
  { permissionSlug: 'project:edit', role: 'project-editor' },
  { permissionSlug: 'project:manage', role: 'project-admin' },
]

export interface ProjectMember {
  organizationMembershipId: string
  userId: string
  email: string | null
  profilePictureUrl: string | null
  name: string
  role: ProjectMemberRole | null
}

/**
 * The full org roster annotated with each member's effective project role
 * (null for org members without project access).
 */
export async function listProjectMembers(
  session: AuthorizedSession,
  projectId: string,
): Promise<ProjectMember[]> {
  await requireProjectAccess(session, projectId, 'project:manage')

  const workos = getWorkOS()

  // WorkOS list endpoints return 10 items per page by default; autoPagination
  // walks every page so rosters larger than one page aren't silently truncated.
  // All five lists are independent — fetch them in parallel.
  const [users, orgMemberships, ...membershipLists] = await Promise.all([
    workos.userManagement
      .listUsers({ organizationId: session.organizationId })
      .then((page) => page.autoPagination()),
    workos.userManagement
      .listOrganizationMemberships({ organizationId: session.organizationId })
      .then((page) => page.autoPagination()),
    ...PROJECT_ROLE_BY_PERMISSION.map(({ permissionSlug }) =>
      workos.authorization
        .listMembershipsForResourceByExternalId({
          organizationId: session.organizationId,
          resourceTypeSlug: 'project',
          externalId: projectId,
          permissionSlug,
          assignment: 'indirect',
        })
        .then((page) => page.autoPagination())
    ),
  ])

  const projectMemberByUserId = new Map<
    string,
    { organizationMembershipId: string; userId: string; role: ProjectMemberRole }
  >()

  const organizationMembersByUserId = new Map(
    orgMemberships.map((membership) => [membership.userId, membership])
  )

  membershipLists.forEach((memberships, index) => {
    const role = PROJECT_ROLE_BY_PERMISSION[index].role
    for (const membership of memberships) {
      const organizationMembership = organizationMembersByUserId.get(membership.userId)
      projectMemberByUserId.set(membership.userId, {
        organizationMembershipId: organizationMembership?.id ?? membership.id,
        userId: membership.userId,
        role,
      })
    }
  })

  const userById = new Map(users.map((user) => [user.id, user]))

  return orgMemberships.map((organizationMembership) => {
    const user = userById.get(organizationMembership.userId)
    const projectMembership = projectMemberByUserId.get(organizationMembership.userId)
    return {
      organizationMembershipId: organizationMembership.id,
      userId: organizationMembership.userId,
      email: user?.email ?? null,
      profilePictureUrl: user?.profilePictureUrl ?? null,
      name:
        user?.name ||
        (user?.firstName
          ? `${user.firstName} ${user.lastName ?? ''}`.trim()
          : user?.lastName || user?.email || organizationMembership.userId),
      role: projectMembership?.role ?? null,
    }
  })
}

/**
 * Set (or clear, with an empty roleSlug) a member's project role. Existing
 * assignments for the membership are removed first so a member never holds
 * two project roles at once. Access-control change — always audited.
 */
export async function setProjectMemberRole(
  session: AuthorizedSession,
  projectId: string,
  input: { organizationMembershipId: string; roleSlug: ProjectMemberRole | '' },
  request: Request,
): Promise<void> {
  await requireProjectAccess(session, projectId, 'project:manage')

  const workosResourceId = await findProjectWorkosResourceId(projectId, session.organizationId)
  if (!workosResourceId) throw new NotFoundError('Project resource not found.')

  const { organizationMembershipId, roleSlug } = input
  const workos = getWorkOS()

  const assignments = await workos.authorization
    .listRoleAssignmentsForResource({ resourceId: workosResourceId })
    .then((page) => page.autoPagination())

  // Reject any change that would drop the project's admin count to zero
  // (ADR-0017: the service owns the invariant). Re-granting admin to the same
  // target keeps them an admin, so it's always allowed.
  assertNotLastAdmin(assignments, organizationMembershipId, roleSlug === PROJECT_ADMIN_ROLE_SLUG)

  await Promise.all(
    assignments
      .filter((assignment) => assignment.organizationMembershipId === organizationMembershipId)
      .map((assignment) =>
        workos.authorization.removeRoleAssignment({
          organizationMembershipId,
          roleAssignmentId: assignment.id,
        })
      )
  )

  if (roleSlug) {
    await workos.authorization.assignRole({
      organizationMembershipId,
      resourceExternalId: projectId,
      resourceTypeSlug: 'project',
      roleSlug,
    })
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: roleSlug ? 'project.role.assigned' : 'project.role.removed',
    targetType: 'project',
    targetId: projectId,
    metadata: { organizationMembershipId, roleSlug: roleSlug || 'none' },
    request,
  })
}

/**
 * Remove a single WorkOS FGA role assignment from a project. Walks every
 * assignment page so assignments beyond the first page are found too.
 * Access-control change — always audited.
 */
export async function removeProjectRoleAssignment(
  session: AuthorizedSession,
  projectId: string,
  assignmentId: string,
  request: Request,
): Promise<void> {
  await requireProjectAccess(session, projectId, 'project:manage')

  const workosResourceId = await findProjectWorkosResourceId(projectId, session.organizationId)
  if (!workosResourceId) throw new NotFoundError()

  const workos = getWorkOS()
  const assignments = await workos.authorization
    .listRoleAssignmentsForResource({ resourceId: workosResourceId })
    .then((page) => page.autoPagination())

  const assignment = assignments.find((a) => a.id === assignmentId)
  if (!assignment) throw new NotFoundError()

  // A bare assignment removal is also a demotion — hold the last-admin line.
  assertNotLastAdmin(assignments, assignment.organizationMembershipId, false)

  await workos.authorization.removeRoleAssignment({
    organizationMembershipId: assignment.organizationMembershipId,
    roleAssignmentId: assignment.id,
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.role.removed',
    targetType: 'project',
    targetId: projectId,
    metadata: { organizationMembershipId: assignment.organizationMembershipId, roleSlug: 'none' },
    request,
  })
}
