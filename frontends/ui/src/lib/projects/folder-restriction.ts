/**
 * Restricting a project folder to WorkOS roles, and lifting it (ADR-0078).
 *
 * Who may: whoever manages the project (`project:manage`, which an
 * organization admin holds through `org:projects:administer`). A project admin
 * who is not cleared for a folder cannot see it, so cannot change it either;
 * an organization admin always can, which is what keeps a restriction naming a
 * role nobody holds from locking a folder away for good.
 *
 * Drawing or lifting the line moves the subtree's documents into the
 * collection the new tree puts them in (`./collection-placement`), so the
 * restriction holds in retrieval, not only in listings, before the request
 * returns for every document whose move succeeded.
 */

import 'server-only'
import { and, eq } from 'drizzle-orm'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { organizationRoleSlugs } from '@/lib/authz/custom-roles'
import { getProjectFolderAccess } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { projectFolders } from '@/lib/db/schema'
import { findProjectInOrg } from '@/lib/projects/repository'
import { placeProjectDocuments, type PlacementResult } from './collection-placement'

/** Most roles one folder may name; mirrors the CHECK in migration 0104. */
export const FOLDER_RESTRICTION_MAX_ROLES = 20

export interface FolderRestrictionResult extends PlacementResult {
  folderId: string
  roles: string[] | null
}

/**
 * Set the roles a folder is restricted to, or `null` to open it. Refuses a
 * role the organization does not have: a slug that names nobody would lock the
 * folder for everyone but the admins, and would do it silently.
 */
export async function setFolderRestriction(
  session: AuthorizedSession,
  input: { projectId: string; folderId: string; roles: string[] | null },
  request: Request
): Promise<FolderRestrictionResult> {
  await requireProjectAccess(session, input.projectId, 'project:manage')
  const project = await findProjectInOrg(input.projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')
  const access = await getProjectFolderAccess(session, input.projectId, project.collectionName)
  if (!access.isVisible(input.folderId)) throw new NotFoundError('Folder not found')

  const roles = input.roles && input.roles.length > 0 ? [...new Set(input.roles)] : null
  if (roles && roles.length > FOLDER_RESTRICTION_MAX_ROLES) {
    throw new BadRequestError(`A folder names at most ${FOLDER_RESTRICTION_MAX_ROLES} roles`)
  }
  if (roles) {
    const known = await organizationRoleSlugs(session.organizationId)
    const unknown = roles.filter((role) => !known.has(role))
    if (unknown.length > 0) throw new BadRequestError(`Not a role of this organization: ${unknown.join(', ')}`)
  }

  const db = getDb()
  const updated = await withTenant({ organizationId: session.organizationId }, () =>
    db
      .update(projectFolders)
      .set({
        restrictedRoles: roles,
        restrictedBy: roles ? session.userId : null,
        restrictedAt: roles ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(projectFolders.id, input.folderId), eq(projectFolders.projectId, input.projectId)))
      .returning({ id: projectFolders.id })
  )
  if (updated.length === 0) throw new NotFoundError('Folder not found')

  const placement = await placeProjectDocuments(session.organizationId, input.projectId)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.folder.access_changed',
    targetType: 'project',
    targetId: input.projectId,
    metadata: { folderId: input.folderId, roles: (roles ?? []).join(','), documentsMoved: placement.moved },
    request,
  })
  return { folderId: input.folderId, roles, ...placement }
}
