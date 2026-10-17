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
import { filterUsersWithProjectAccess } from '@/lib/authz/project-membership'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import type { ShareableResourceType } from '@/lib/db/schema'
import { findDocumentForSession } from '@/lib/documents/access'
import { mayOpenDocument } from '@/lib/documents/may-open'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems } from '@/lib/inbox/service'
import { requireResourceAccess, requireResourceWriteAccess } from '@/lib/sharing/access'
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
 * when there is no project), and for a document the folder it is filed in.
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
  const allowed = await whoMayOpen(
    session,
    resourceType,
    resourceId,
    access.container.projectId,
    others.map((person) => person.userId),
  )
  return others
    .filter((person) => allowed.has(person.userId))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Which of `userIds` could open the resource: a document by its shelf AND the
 * folder it is filed in (`mayOpenDocument`), because a project member who may
 * not read a restricted folder would be on the hook for a file they cannot
 * see; anything else by its project, or everyone when it has none.
 */
async function whoMayOpen(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  projectId: string | null,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (resourceType === 'document') {
    const doc = await findDocumentForSession(session, resourceId)
    if (!doc) throw new NotFoundError()
    if (doc.scope === 'project' || doc.scope === 'archiv') return mayOpenDocument(session, doc, userIds)
  }
  if (!projectId) return new Set(userIds)
  return filterUsersWithProjectAccess(session, projectId, userIds)
}

/**
 * Who is assigned to ONE resource. Requires `viewer` on it.
 *
 * The route used to call the batch helper below directly, which checks
 * nothing, while its `authz` declaration claimed it did: any member of the
 * organization could read who is on the hook for a private chat or a document
 * in a project they are not in, given its id. A 404 for "missing" and "not
 * yours" alike, as everywhere in `requireResourceAccess`.
 */
export async function listResourceAssignments(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<AssignedPerson[]> {
  if (!isCollaborationEnabled(session)) {
    throw new NotFoundError()
  }
  await requireResourceAccess(session, resourceType, resourceId, 'viewer')
  const grouped = await listAssignmentsWithoutAccessCheck(session, resourceType, [resourceId])
  return grouped[resourceId] ?? []
}

/**
 * Assignees for many resources at once, grouped by id. **Checks no access.**
 *
 * For callers that have already authorized every id they pass — a document
 * listing behind `project:view` on the project the ids were read from, and the
 * assign/release paths after their own `collaborator` check. Anything taking
 * ids from a request goes through {@link listResourceAssignments}.
 */
export async function listAssignmentsWithoutAccessCheck(
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
  // Putting someone on the hook for a document is a change to it (ADR-0088).
  await requireResourceWriteAccess(session, resourceType, resourceId)
  if (!subjectUserId.trim()) {
    throw new BadRequestError('A person is required')
  }

  const allowed = await whoMayOpen(session, resourceType, resourceId, access.container.projectId, [subjectUserId])
  if (!allowed.has(subjectUserId)) {
    throw new BadRequestError('That person cannot open this, so they cannot be assigned to it', {
      reason: 'container-access-required',
    })
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

  // Authorized above (`collaborator`).
  const grouped = await listAssignmentsWithoutAccessCheck(session, resourceType, [resourceId])
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
  await requireResourceWriteAccess(session, resourceType, resourceId)
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

  // Authorized above (`collaborator`).
  const grouped = await listAssignmentsWithoutAccessCheck(session, resourceType, [resourceId])
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
