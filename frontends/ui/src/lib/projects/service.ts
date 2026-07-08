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
import { recordAuditEvent } from '@/lib/audit/service'
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

export async function listProjects(session: AuthorizedSession): Promise<Project[]> {
  return listProjectsInOrg(session.organizationId)
}

/**
 * Create a project, register it as a WorkOS FGA resource, and make the
 * creator its project-admin.
 */
export async function createProject(
  session: AuthorizedSession,
  input: { name: string },
  request: Request,
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

  await setProjectWorkosResourceId(project.id, resource.id)

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

  const restored = await restoreProjectIfPending(projectId)
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
  await requireProjectAccess(session, projectId, 'project:edit')
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
  await requireProjectAccess(session, projectId, 'project:edit')
  const item = await updateProjectMemoryItem({ projectId }, itemId, patch)
  if (!item) throw new NotFoundError()
  return item
}

export async function removeProjectMemoryItem(
  session: AuthorizedSession,
  projectId: string,
  itemId: string,
): Promise<void> {
  await requireProjectAccess(session, projectId, 'project:edit')
  const deleted = await deleteProjectMemoryItem({ projectId }, itemId)
  if (!deleted) throw new NotFoundError()
}
