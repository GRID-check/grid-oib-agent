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
import { checkResourcePermission } from '@/lib/authz/resource-check'
import { recordAuditEvent } from '@/lib/audit/service'
import { neutralizeCollaborationForProject } from '@/lib/collaboration/cleanup'
import { listConversationIdsForProject } from '@/lib/conversations/repository'
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
import { getProjectOverviewData } from './overview-query'
import {
  createProjectMemoryItem,
  deleteProjectMemoryItem,
  listProjectMemory,
  updateProjectMemoryItem,
} from './memory-service'
import {
  findProjectInOrg,
  insertProject,
  listProjectsInOrg,
  renameProjectInOrg,
  restoreProjectIfPending,
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
 * Org admins keep seeing everything (the same named bypass `requireProjectAccess`
 * applies), and the checks run concurrently so the page costs one round of
 * parallel FGA calls rather than a serial walk. Each check **fails closed**
 * independently: a project whose check errors is omitted rather than shown.
 */
export async function listProjects(
  session: AuthorizedSession,
  order: 'newest' | 'oldest' = 'newest',
): Promise<Project[]> {
  const projects = await listProjectsInOrg(session.organizationId, { order })
  if (session.role === 'admin') return projects

  const visible = await Promise.all(
    projects.map(async (project) => {
      const allowed = await checkResourcePermission({
        organizationMembershipId: session.organizationMembershipId,
        permissionSlug: 'project:view',
        resourceExternalId: project.id,
        resourceTypeSlug: 'project',
      })
      return allowed ? project : null
    }),
  )
  return visible.filter((project): project is Project => project !== null)
}

/**
 * Everything the projects grid renders: the reachable projects and their
 * document counts.
 *
 * Exists so the page has a service call for its whole view instead of a reason
 * to open the database itself. The page previously ran its own
 * `select().from(projects)` filtered only by organization, which bypassed the
 * FGA filtering in {@link listProjects} and put every project in the tenant on
 * screen for every member — the precise regression ADR-0038 closed. Counting is
 * derived from the filtered list for the same reason.
 */
export async function getProjectsGridData(
  session: AuthorizedSession,
  order: 'newest' | 'oldest' = 'newest',
): Promise<{ projects: Project[]; documentCounts: Record<string, number> }> {
  const visible = await listProjects(session, order)
  const documentCounts = await countDocumentsByProject(
    session.organizationId,
    visible.map((project) => project.id),
  )
  return { projects: visible, documentCounts }
}

/**
 * Create a project, register it as a WorkOS FGA resource, and make the
 * creator its project-admin.
 */
export async function createProject(
  session: AuthorizedSession,
  input: { name: string },
  // Optional because the projects-page server action has no `Request` to pass.
  // `recordAuditEvent` already treats it as optional (it only enriches the event
  // context with IP + user agent), so requiring it here was the sole reason that
  // action re-implemented this whole function instead of calling it.
  request?: Request,
): Promise<Project> {
  const workos = getWorkOS()

  const project = await insertProject({
    organizationId: session.organizationId,
    name: input.name,
    createdBy: session.userId,
    collectionName: `proj_${crypto.randomUUID()}`,
  })

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
  name: string,
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
  request: Request,
): Promise<{ purgeAfter: Date }> {
  await requireProjectAccess(session, projectId, 'project:manage')

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

/** Restore a soft-deleted project during its grace period. */
export async function restoreProject(
  session: AuthorizedSession,
  projectId: string,
  request: Request,
): Promise<void> {
  await requireProjectAccess(session, projectId, 'project:manage', { includeDeleted: true })

  const restored = await restoreProjectIfPending(projectId, session.organizationId)
  if (!restored) {
    throw new ConflictError('No pending deletion to restore (already purged, or purge in progress).')
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

export async function getProjectOverview(session: AuthorizedSession, projectId: string) {
  await requireProjectAccess(session, projectId, 'project:view')
  const data = await getProjectOverviewData(projectId, session.organizationId)
  if (!data) throw new NotFoundError('Project not found')
  return data
}

/** The fields a member may edit on an existing memory item. */
export type ProjectMemoryItemPatch = Partial<
  Pick<ProjectMemoryItem, 'content' | 'kind' | 'status' | 'confidence' | 'verification' | 'pinned'>
>

/**
 * List a project's memory items, including the org-wide items that apply to
 * every project in the org.
 */
export async function getProjectMemory(
  session: AuthorizedSession,
  projectId: string,
  options: { includeArchived?: boolean; sourceConversationId?: string } = {},
): Promise<ProjectMemoryItem[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  return listProjectMemory(projectId, { ...options, organizationId: session.organizationId })
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
  },
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
  patch: ProjectMemoryItemPatch,
): Promise<ProjectMemoryItem> {
  await requireProjectAccess(session, projectId, ['project:memory:write', 'project:edit'])
  const item = await updateProjectMemoryItem({ projectId }, itemId, patch)
  if (!item) throw new NotFoundError()
  return item
}

export async function removeProjectMemoryItem(
  session: AuthorizedSession,
  projectId: string,
  itemId: string,
): Promise<void> {
  await requireProjectAccess(session, projectId, ['project:memory:write', 'project:edit'])
  const deleted = await deleteProjectMemoryItem({ projectId }, itemId)
  if (!deleted) throw new NotFoundError()
}
