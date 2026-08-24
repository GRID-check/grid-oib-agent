/**
 * Assignment service — who is professionally on the hook (ADR-0047).
 *
 * Independent of access grants. Assigning Anna does not change who can open
 * the file. Upload writes no row. Empty is valid.
 */

import 'server-only'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canUserAccessProject, filterUsersWithProjectAccess } from '@/lib/authz/project-membership'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import type { ShareableResourceType } from '@/lib/db/schema'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems } from '@/lib/inbox/service'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory, unknownPerson } from '@/lib/sharing/directory'
import { describeResource } from '@/lib/sharing/registry'
import type { DirectoryPerson } from '@/lib/sharing/types'
import {
  deleteAssignment,
  insertAssignment,
  listAssignmentsForResources,
} from './repository'

export interface AssignedPerson extends DirectoryPerson {
  assignedBy: string
}

/**
 * People a collaborator may put on the hook (ADR-0047).
 *
 * Requires `collaborator` — the same floor as assign/release. Distinct from
 * share-invite candidates (`listShareCandidates`), which require `owner`
 * because that list exists to change the access roster and includes people
 * who still need project access. Assignment never grants access, so this
 * list is only people who already reach the container (or the whole org
 * when there is no project).
 */
export async function listAssignmentCandidates(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<DirectoryPerson[]> {
  if (!isCollaborationEnabled(session)) {
    throw new NotFoundError()
  }
  const access = await requireResourceAccess(session, resourceType, resourceId, 'collaborator')
  const directory = await loadOrganizationDirectory(session.organizationId)
  const others = [...directory.values()].filter((person) => person.userId !== session.userId)
  if (!access.container.projectId) {
    return others.sort((a, b) => a.name.localeCompare(b.name))
  }
  const allowed = await filterUsersWithProjectAccess(
    session,
    access.container.projectId,
    others.map((person) => person.userId),
  )
  return others
    .filter((person) => allowed.has(person.userId))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listResourceAssignments(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceIds: readonly string[],
): Promise<Record<string, AssignedPerson[]>> {
  if (resourceIds.length === 0) return {}
  const rows = await listAssignmentsForResources(session.organizationId, resourceType, resourceIds)
  const directory = await loadOrganizationDirectory(session.organizationId)
  const grouped: Record<string, AssignedPerson[]> = {}
  for (const row of rows) {
    const person = directory.get(row.subjectUserId) ?? unknownPerson(row.subjectUserId)
    const list = grouped[row.resourceId] ?? []
    list.push({ ...person, assignedBy: row.assignedBy })
    grouped[row.resourceId] = list
  }
  return grouped
}

export async function addResourceAssignment(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
  request?: Request,
): Promise<AssignedPerson[]> {
  if (!isCollaborationEnabled(session)) {
    throw new NotFoundError()
  }
  const access = await requireResourceAccess(session, resourceType, resourceId, 'collaborator')
  if (!subjectUserId.trim()) {
    throw new BadRequestError('A person is required')
  }

  if (access.container.projectId) {
    const allowed = await canUserAccessProject(session, access.container.projectId, subjectUserId)
    if (!allowed) {
      throw new BadRequestError('That person is not in this project', {
        reason: 'container-access-required',
      })
    }
  }

  await insertAssignment({
    organizationId: session.organizationId,
    resourceType,
    resourceId,
    subjectUserId,
    assignedBy: session.userId,
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'resource.assigned',
    targetType: resourceType,
    targetId: resourceId,
    metadata: { subjectUserId },
    request,
  })

  if (subjectUserId !== session.userId) {
    const descriptor = describeResource(resourceType)
    const ref = await descriptor.describeRef(resourceId, session.organizationId)
    await emitInboxItems([
      {
        organizationId: session.organizationId,
        recipientUserId: subjectUserId,
        type: 'document.assigned_to_you',
        resourceType,
        resourceId,
        actorUserId: session.userId,
        groupKey: inboxGroupKey('document.assigned_to_you', resourceType, resourceId),
        payload: { subject: ref?.title ?? null },
      },
    ])
  }

  const grouped = await listResourceAssignments(session, resourceType, [resourceId])
  return grouped[resourceId] ?? []
}

export async function removeResourceAssignment(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
  request?: Request,
): Promise<AssignedPerson[]> {
  if (!isCollaborationEnabled(session)) {
    throw new NotFoundError()
  }
  await requireResourceAccess(session, resourceType, resourceId, 'collaborator')
  await deleteAssignment(session.organizationId, resourceType, resourceId, subjectUserId)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'resource.unassigned',
    targetType: resourceType,
    targetId: resourceId,
    metadata: { subjectUserId },
    request,
  })

  const grouped = await listResourceAssignments(session, resourceType, [resourceId])
  return grouped[resourceId] ?? []
}

export async function assignMany(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceIds: readonly string[],
  subjectUserId: string,
  request?: Request,
): Promise<void> {
  for (const resourceId of resourceIds) {
    await addResourceAssignment(session, resourceType, resourceId, subjectUserId, request)
  }
}
