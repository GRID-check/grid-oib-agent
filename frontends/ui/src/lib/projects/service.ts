/**
 * Projects service — business logic for the projects domain.
 *
 * Owns authorization (org tenancy + per-project FGA), orchestration across
 * the repository, WorkOS, and the audit trail. Route handlers stay thin:
 * they validate input shape and delegate here. Failures are signalled with
 * typed errors from `@/lib/api/errors`.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { requireProjectAccess } from '@/lib/authz/projects'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { checkResourcePermission } from '@/lib/authz/resource-check'
import { recordAuditEvent } from '@/lib/audit/service'
import { neutralizeCollaborationForProject } from '@/lib/collaboration/cleanup'
import {
  lastProjectActivityByUser,
  listConversationIdsForProject,
} from '@/lib/conversations/repository'
import { countDocumentsByProject } from '@/lib/documents/repository'
import { computePurgeAfter, projectGraceDays } from '@/lib/deletion/policy'
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type {
  Project,
  ProjectMemoryConfidence,
  ProjectMemoryItem,
  ProjectMemoryKind,
} from '@/lib/db/schema'
import { getProjectOverviewData, type ProjectOverviewReader } from './overview-query'
import { isProjectClosed, type ProjectStatus } from './project-status'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import {
  clearanceOf,
  customFolderNames,
  getHiddenFolderIds,
  purgedFolderDates,
  readableFolderIdsFor,
} from '@/lib/authz/folder-access'
import {
  createProjectMemoryItem,
  deleteProjectMemoryItem,
  listProjectMemory,
  updateProjectMemoryItem,
} from './memory-service'
import {
  deleteProjectRow,
  findProjectCollectionName,
  findProjectInOrg,
  insertProject,
  listProjectsInOrg,
  renameProjectInOrg,
  restoreProjectIfPending,
  setProjectStatusInOrg,
  setProjectWorkosResourceId,
  softDeleteProjectAndEnqueue,
} from './repository'

/**
 * Projects the caller can actually reach, not merely the ones their tenant owns.
 *
 * The listing used to return every non-deleted project in the organization while
 * `getProject` gated on per-project FGA — so the detail view was protected and
 * the list that fed it was not. Any member enumerated every project name and id
 * in the tenant, which is exactly the distinction `project-viewer` /
 * `project-editor` / `project-admin` exist to draw (ADR-0038).
 *
 * Callers holding `org:projects:administer` keep seeing everything (the same
 * named bypass `requireProjectAccess` applies), and the checks run concurrently so the page costs one round of
 * parallel FGA calls rather than a serial walk. Each check **fails closed**
 * independently: a project whose check errors is omitted rather than shown.
 */
export async function listProjects(
  session: AuthorizedSession,
  order: 'newest' | 'oldest' = 'newest'
): Promise<Project[]> {
  const projects = await listProjectsInOrg(session.organizationId, { order })
  // The same permission-gated bypass `requireProjectAccess` applies, checked the
  // same way — if these two ever disagreed the grid would list projects the
  // detail view then refuses, or hide ones it would have opened.
  if (hasPermission(session, ORG_PERMISSIONS.projectsAdminister)) return projects

  const visible = await Promise.all(
    projects.map(async (project) => {
      // Every member reads a closed project (ADR-0088), and so finds it here.
      if (isProjectClosed(project)) return project
      const allowed = await checkResourcePermission({
        organizationMembershipId: session.organizationMembershipId,
        organizationId: session.organizationId,
        permissionSlug: 'project:view',
        resourceExternalId: project.id,
        resourceTypeSlug: 'project',
      })
      return allowed ? project : null
    })
  )
  return visible.filter((project): project is Project => project !== null)
}

/**
 * Everything the projects grid renders: the reachable projects, their document
 * counts, and when the caller themselves last worked in each of them.
 *
 * Exists so the page has a service call for its whole view instead of a reason
 * to open the database itself. The page previously ran its own
 * `select().from(projects)` filtered only by organization, which bypassed the
 * FGA filtering in {@link listProjects} and put every project in the tenant on
 * screen for every member — the precise regression ADR-0038 closed. Counting is
 * derived from the filtered list for the same reason.
 *
 * `viewerActivity` is per-CALLER by construction (see
 * {@link lastProjectActivityByUser}) and asked only for projects that survived
 * the FGA filter, so it can neither leak another member's working pattern nor
 * name a project the caller cannot open. Both derived reads run against the
 * filtered list, concurrently — they do not depend on each other.
 */
export async function getProjectsGridData(
  session: AuthorizedSession,
  order: 'newest' | 'oldest' = 'newest'
): Promise<{
  projects: Project[]
  documentCounts: Record<string, number>
  /** ISO timestamp of the caller's own last activity, keyed by project id. */
  viewerActivity: Record<string, string>
}> {
  const visible = await listProjects(session, order)
  const visibleIds = visible.map((project) => project.id)
  // A card's number counts what the project's own list shows this viewer, so
  // the documents in folders they may not read are left out of it (ADR-0087).
  const hiddenFolderIds = (await Promise.all(visibleIds.map((id) => getHiddenFolderIds(session, id)))).flat()
  // Nor does it count a held file the viewer neither uploaded nor reviews
  // (ADR-0083); each project asks its own reviewers.
  const readers = await Promise.all(visibleIds.map((projectId) => shelfReaderFor(session, { scope: 'project', projectId })))
  const reviewedProjectIds = visibleIds.filter((_, index) => readers[index].kind === 'reviewer')
  const [documentCounts, viewerActivity] = await Promise.all([
    countDocumentsByProject(session.organizationId, visibleIds, hiddenFolderIds, {
      kind: 'projects',
      userId: session.userId,
      reviewedProjectIds,
    }),
    lastProjectActivityByUser(session.organizationId, session.userId, visibleIds),
  ])
  return { projects: visible, documentCounts, viewerActivity }
}

/**
 * Create a project, register it as a WorkOS FGA resource, and make the
 * creator its project-admin.
 *
 * ## Why the compensating delete
 *
 * Four steps across two systems that share no transaction: insert the row,
 * create the FGA resource, store its id, grant the creator `project-admin`. A
 * failure after the first one used to leave a project row with no FGA resource
 * and no admin — which, because per-project access is FGA, is a project its own
 * creator cannot open. The only way back in was the org-wide bypass, and there
 * is no repair path in the product, so the project was simply lost while still
 * counting against the tenant.
 *
 * Postgres is the side that can be undone cleanly, so it is: on any failure the
 * row is removed and the caller sees the error. A leaked WorkOS resource with no
 * row pointing at it is inert (nothing resolves it, and project ids are UUIDs so
 * it can never be re-hit), which makes it the right thing to leak of the two.
 */
export async function createProject(
  session: AuthorizedSession,
  input: { name: string },
  // Optional because the projects-page server action has no `Request` to pass.
  // `recordAuditEvent` already treats it as optional (it only enriches the event
  // context with IP + user agent), so requiring it here was the sole reason that
  // action re-implemented this whole function instead of calling it.
  request?: Request
): Promise<Project> {
  const workos = getWorkOS()

  const project = await insertProject({
    organizationId: session.organizationId,
    name: input.name,
    createdBy: session.userId,
    collectionName: `proj_${crypto.randomUUID()}`,
  })

  try {
    const resource = await workos.authorization.createResource({
      resourceTypeSlug: 'project',
      externalId: project.id,
      organizationId: session.organizationId,
      name: input.name,
    })

    await setProjectWorkosResourceId(project.id, session.organizationId, resource.id)

    await workos.authorization.assignRole({
      organizationMembershipId: session.organizationMembershipId,
      resourceExternalId: project.id,
      resourceTypeSlug: 'project',
      roleSlug: 'project-admin',
    })
  } catch (error) {
    // Best-effort undo. If even this fails the row survives unreachable, which is
    // the state we are trying to avoid — so say so loudly rather than swallow it.
    await deleteProjectRow(project.id, session.organizationId).catch((cleanupError) => {
      console.error(
        `[projects] project ${project.id} was created without FGA access and could not be rolled back:`,
        cleanupError
      )
    })
    throw error
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.created',
    targetType: 'project',
    targetId: project.id,
    metadata: { name: input.name },
    request,
  })

  return project
}

export async function getProject(session: AuthorizedSession, projectId: string): Promise<Project> {
  await requireProjectAccess(session, projectId, 'project:view')
  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError()
  return project
}

export async function updateProjectName(
  session: AuthorizedSession,
  projectId: string,
  name: string
): Promise<Project> {
  await requireProjectAccess(session, projectId, 'project:manage')
  const project = await renameProjectInOrg(projectId, session.organizationId, name)
  if (!project) throw new NotFoundError()
  return project
}

/**
 * Soft-delete a project (name confirmation required) and enqueue the purge.
 * Returns the purge deadline for the 202 response.
 */
export async function deleteProject(
  session: AuthorizedSession,
  projectId: string,
  confirmName: string,
  request: Request
): Promise<{ purgeAfter: Date }> {
  // A closed project can still be deleted (ADR-0088): deletion is the GDPR
  // path, and it is soft, with its grace period, exactly as for an active one.
  await requireProjectAccess(session, projectId, 'project:manage', { evenWhenClosed: true })

  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError()
  if (confirmName !== project.name) {
    throw new BadRequestError('Project name does not match.')
  }

  const purgeAfter = computePurgeAfter(new Date(), projectGraceDays())
  await softDeleteProjectAndEnqueue(project, session.userId, purgeAfter)

  // Every conversation in the project just became unreachable, so collaboration
  // state that assumes someone can READ those threads must be settled: open
  // mention requests are voided (nobody can answer a thread they cannot open, and
  // the hand-off banner would otherwise wait forever) and inbox items go inert
  // with their payloads wiped, so a quoted snippet cannot outlive access to the
  // thread it came from.
  //
  // Grants are deliberately KEPT: a soft delete may be restored during the grace
  // period, and the project should come back with its threads shared exactly as
  // they were (spec SH-13). Best-effort — a deletion must not fail on bookkeeping.
  try {
    const conversationIds = await listConversationIdsForProject(projectId, session.organizationId)
    await neutralizeCollaborationForProject(session.organizationId, projectId, conversationIds)
  } catch (error) {
    console.warn('[projects] collaboration neutralization on project delete failed:', error)
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.deleted',
    targetType: 'project',
    targetId: projectId,
    metadata: { name: project.name, purgeAfter: purgeAfter.toISOString() },
    request,
  })

  return { purgeAfter }
}

/**
 * Close a project, or reopen it (ADR-0088). `project:manage`, asked as if the
 * project were active: it is the one write a closed project allows. Closing
 * deletes and purges nothing; it makes the project read-only and opens it to
 * every member of the organization for reading, with every folder that has its
 * own role list as restricted as before. Both directions are audited. A
 * project already in the requested state is a conflict, so a double click
 * writes one event.
 */
export async function setProjectStatus(
  session: AuthorizedSession,
  projectId: string,
  status: ProjectStatus,
  request?: Request
): Promise<Project> {
  await requireProjectAccess(session, projectId, 'project:manage', { evenWhenClosed: true })
  const project =
    status === 'closed'
      ? await setProjectStatusInOrg(projectId, session.organizationId, {
          status: 'closed',
          closedBy: session.userId,
          at: new Date(),
        })
      : await setProjectStatusInOrg(projectId, session.organizationId, { status: 'active' })
  if (!project) {
    throw new ConflictError(status === 'closed' ? 'The project is already closed.' : 'The project is not closed.', {
      reason: status === 'closed' ? 'already-closed' : 'not-closed',
    })
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: status === 'closed' ? 'project.closed' : 'project.reopened',
    targetType: 'project',
    targetId: projectId,
    metadata: { name: project.name },
    request,
  })
  return project
}

/** Restore a soft-deleted project during its grace period. */
export async function restoreProject(
  session: AuthorizedSession,
  projectId: string,
  request: Request
): Promise<void> {
  await requireProjectAccess(session, projectId, 'project:manage', { includeDeleted: true, evenWhenClosed: true })

  const restored = await restoreProjectIfPending(projectId, session.organizationId)
  if (!restored) {
    throw new ConflictError(
      'No pending deletion to restore (already purged, or purge in progress).'
    )
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.restored',
    targetType: 'project',
    targetId: projectId,
    request,
  })
}

/**
 * What the overview's count, size and recent list leave out for this session:
 * the folders hidden from it (ADR-0084) and the held files it neither
 * uploaded nor reviews (ADR-0083). One answer for every page that renders the
 * overview data, so a second reader dimension cannot reach one and miss the other.
 */
export async function projectOverviewReader(
  session: AuthorizedSession,
  projectId: string
): Promise<ProjectOverviewReader> {
  return {
    hiddenFolderIds: await getHiddenFolderIds(session, projectId),
    reader: await shelfReaderFor(session, { scope: 'project', projectId }),
  }
}

export async function getProjectOverview(session: AuthorizedSession, projectId: string) {
  await requireProjectAccess(session, projectId, 'project:view')
  const reader = await projectOverviewReader(session, projectId)
  const data = await getProjectOverviewData(projectId, session.organizationId, reader)
  if (!data) throw new NotFoundError('Project not found')
  return data
}

/** The fields a member may edit on an existing memory item. */
export type ProjectMemoryItemPatch = Partial<
  Pick<ProjectMemoryItem, 'content' | 'kind' | 'status' | 'confidence' | 'verification' | 'pinned'>
>

/**
 * A memory item as the panel receives it. A restricted item (ADR-0086) also
 * names the folders it is restricted to, for the lock; it only reaches a reader
 * already cleared for all of them.
 */
export type ProjectMemoryListItem = ProjectMemoryItem & {
  restrictedFolderNames?: string[]
  /**
   * When a folder the note came from was purged (ADR-0087): the panel's
   * „Quelle gelöscht am …". The earliest, when several were.
   */
  sourceDeletedAt?: string
}

/**
 * Every folder of the project (tombstones included) this session may read now
 * (ADR-0087): what restricted memory is shown against. A project not found in
 * the organization reads nothing restricted.
 */
export async function memoryClearance(
  session: AuthorizedSession,
  projectId: string
): Promise<{ cleared: readonly string[] }> {
  const projectCollection = await findProjectCollectionName(projectId, session.organizationId)
  if (!projectCollection) return { cleared: [] }
  return { cleared: await readableFolderIdsFor(session.organizationId, projectId, await clearanceOf(session, projectId)) }
}

/** Name the folders behind each restricted item; open items pass through untouched. */
async function labelRestrictions(
  session: AuthorizedSession,
  projectId: string,
  items: ProjectMemoryItem[]
): Promise<ProjectMemoryListItem[]> {
  if (!items.some((item) => (item.restrictedFolderIds?.length ?? 0) > 0)) return items
  const [names, purgedAt] = await Promise.all([
    customFolderNames(session.organizationId, projectId),
    purgedFolderDates(session.organizationId, projectId),
  ])
  return items.map((item) => {
    if (!item.restrictedFolderIds || item.restrictedFolderIds.length === 0) return item
    const deleted = item.restrictedFolderIds
      .flatMap((folderId) => {
        const at = purgedAt.get(folderId)
        return at ? [at.toISOString()] : []
      })
      .sort()
    return {
      ...item,
      restrictedFolderNames: item.restrictedFolderIds
        .map((folderId) => names.get(folderId))
        .filter((name): name is string => name !== undefined),
      ...(deleted.length > 0 ? { sourceDeletedAt: deleted[0] } : {}),
    }
  })
}

/**
 * List a project's memory items, including the org-wide items that apply to
 * every project in the org. A restricted item (ADR-0087) is listed only for a
 * session that may read all of its source folders now; for anyone else it is absent.
 */
export async function getProjectMemory(
  session: AuthorizedSession,
  projectId: string,
  options: { includeArchived?: boolean; sourceConversationId?: string } = {}
): Promise<ProjectMemoryListItem[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  const { cleared } = await memoryClearance(session, projectId)
  const items = await listProjectMemory(projectId, {
    ...options,
    organizationId: session.organizationId,
    readableFolderIds: cleared,
  })
  return labelRestrictions(session, projectId, items)
}

/** Manually add a memory item — user-authored and user-confirmed by definition. */
export async function addProjectMemoryItem(
  session: AuthorizedSession,
  projectId: string,
  input: {
    kind: ProjectMemoryKind
    content: string
    confidence?: ProjectMemoryConfidence
    pinned?: boolean
  }
): Promise<ProjectMemoryItem> {
  await requireProjectAccess(session, projectId, ['project:memory:write', 'project:edit'])
  return createProjectMemoryItem({
    scope: 'project',
    projectId,
    organizationId: session.organizationId,
    kind: input.kind,
    content: input.content,
    confidence: input.confidence ?? 'medium',
    pinned: input.pinned ?? false,
    provenanceType: 'user',
    verification: 'user_confirmed',
    createdBy: session.userId,
  })
}

export async function editProjectMemoryItem(
  session: AuthorizedSession,
  projectId: string,
  itemId: string,
  patch: ProjectMemoryItemPatch
): Promise<ProjectMemoryItem> {
  await requireProjectAccess(session, projectId, ['project:memory:write', 'project:edit'])
  // A restricted item the session is not cleared for answers like a missing one.
  const { cleared } = await memoryClearance(session, projectId)
  const item = await updateProjectMemoryItem(
    { projectId, organizationId: session.organizationId, readableFolderIds: cleared },
    itemId,
    patch
  )
  if (!item) throw new NotFoundError()
  return item
}

export async function removeProjectMemoryItem(
  session: AuthorizedSession,
  projectId: string,
  itemId: string
): Promise<void> {
  await requireProjectAccess(session, projectId, ['project:memory:write', 'project:edit'])
  const { cleared } = await memoryClearance(session, projectId)
  const deleted = await deleteProjectMemoryItem(
    { projectId, organizationId: session.organizationId, readableFolderIds: cleared },
    itemId
  )
  if (!deleted) throw new NotFoundError()
}
