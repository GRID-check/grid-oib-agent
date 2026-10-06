/**
 * Setting who may read and who may write a project folder (ADR-0079).
 *
 * A folder inherits its parent's access, or has its own list: WorkOS roles
 * (and `*`, every project member), each with `read` or `write`. Nesting only
 * narrows (`effectiveFolderLevel`), so an own list on a subfolder can take
 * access away from what the parent gives and never add to it.
 *
 * Who may change it: whoever manages the project (`project:manage`, which an
 * organization admin holds through `org:projects:administer`) AND may write the
 * folder. Changing its list is the strongest write there is on it: a manager
 * who could do it with only Lesen could give themselves Bearbeiten. One who may
 * not read the folder cannot see it, so cannot change it either. An
 * organization admin writes everywhere, which is what keeps a list naming a
 * role nobody holds from locking a folder away for good.
 *
 * Writing the folder is also what keeps a change from granting the caller more
 * than they hold: the level on a folder is the minimum over its path, so
 * someone who writes it already holds the most any list on it could give.
 *
 * Changing who may READ moves the subtree's documents into the collection the
 * new tree puts them in (`./collection-placement`), so the change holds in
 * retrieval, not only in listings, before the request returns for every
 * document whose move succeeded. Changing who may only WRITE moves nothing.
 */

import 'server-only'
import { and, eq, isNull } from 'drizzle-orm'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { organizationRoleSlugs } from '@/lib/authz/custom-roles'
import {
  clearanceOf,
  computeFolderAccess,
  customFolderNames,
  EVERY_PROJECT_MEMBER,
  folderReadOnlyError,
  foldersWithoutValidRole,
  getProjectFolderAccess,
  loadCustomFolderTree,
  type FolderGrant,
} from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { projectFolderGrants, projectFolders } from '@/lib/db/schema'
import { findProjectInOrg } from '@/lib/projects/repository'
import { placeProjectDocuments, type PlacementResult } from './collection-placement'
import { assertRestrictionKeepsIfcOpen } from './ifc-folder-guard'

/** Most entries one folder's own list may hold; mirrors the 0108 constraint trigger. */
export const FOLDER_ACCESS_MAX_GRANTS = 20

/** A folder's access, as it is set. */
export type FolderAccessSetting = { mode: 'inherit' } | { mode: 'custom'; grants: FolderGrant[] }

export interface FolderAccessResult extends PlacementResult {
  folderId: string
  access: FolderAccessSetting
}

/** The audit form of a list: `role:level`, comma-joined, sorted. */
export function describeGrants(grants: readonly FolderGrant[]): string {
  return grants
    .map((grant) => `${grant.role}:${grant.level}`)
    .sort()
    .join(',')
}

/**
 * The list as it may be stored: one entry per role, 1 to
 * {@link FOLDER_ACCESS_MAX_GRANTS} of them, each a role of the organization or
 * `*`. A role named twice is refused rather than guessed at.
 */
async function validatedGrants(organizationId: string, grants: readonly FolderGrant[]): Promise<FolderGrant[]> {
  if (grants.length === 0) {
    throw new BadRequestError('A folder with its own access list needs at least one entry')
  }
  if (grants.length > FOLDER_ACCESS_MAX_GRANTS) {
    throw new BadRequestError(`A folder names at most ${FOLDER_ACCESS_MAX_GRANTS} roles`)
  }
  const roles = grants.map((grant) => grant.role)
  if (new Set(roles).size !== roles.length) throw new BadRequestError('A role is listed twice')
  const named = roles.filter((role) => role !== EVERY_PROJECT_MEMBER)
  if (named.length > 0) {
    // A slug that names nobody would lock the folder for everyone but the
    // admins, and would do it silently.
    const known = await organizationRoleSlugs(organizationId)
    const unknown = named.filter((role) => !known.has(role))
    if (unknown.length > 0) throw new BadRequestError(`Not a role of this organization: ${unknown.join(', ')}`)
  }
  return grants.map((grant) => ({ role: grant.role, level: grant.level }))
}

/** A folder whose own list names no role that exists any more. */
export interface FolderWithoutValidRole {
  id: string
  name: string
}

/**
 * The project's folders left without a valid role (ADR-0079): their own list
 * names only roles deleted from the organization since, so organization admins
 * are the only ones who read them. For the project settings to flag, with a
 * link to each.
 *
 * `project:manage`, and only the folders this session may itself see: a folder
 * nobody but admins reads is not named to a project admin who is not one. When
 * the roles cannot be listed (WorkOS unreachable) the answer is none, because
 * naming a folder an outage merely hid the role of would be a false alarm; the
 * next load asks again.
 */
export async function listFoldersWithoutValidRole(
  session: AuthorizedSession,
  projectId: string
): Promise<FolderWithoutValidRole[]> {
  await requireProjectAccess(session, projectId, 'project:manage')
  const folders = await loadCustomFolderTree(session.organizationId, projectId)
  if (!folders) return []
  const existing = await organizationRoleSlugs(session.organizationId).catch((error: unknown) => {
    console.warn('[folder-access] cannot list the roles; flagging no folder:', error)
    return null
  })
  if (!existing) return []
  const orphaned = foldersWithoutValidRole(folders, existing)
  if (orphaned.length === 0) return []
  const access = computeFolderAccess(folders, await clearanceOf(session), '')
  const names = await customFolderNames(session.organizationId, projectId)
  return orphaned
    .filter((folderId) => access.isVisible(folderId))
    .map((folderId) => ({ id: folderId, name: names.get(folderId) ?? folderId }))
}

/**
 * Set a folder's access: inherit, or its own list. Needs `project:manage` and
 * write on the folder (404 when the folder is not readable, a typed 403 when
 * it is only readable). Refuses a role the organization does not have, an
 * empty list (inherit is the way to say "everyone, as the parent"), and a list
 * that would put an IFC model in a folder not every member may read.
 */
export async function setFolderAccess(
  session: AuthorizedSession,
  input: { projectId: string; folderId: string; access: FolderAccessSetting },
  request: Request
): Promise<FolderAccessResult> {
  await requireProjectAccess(session, input.projectId, 'project:manage')
  const project = await findProjectInOrg(input.projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')
  const current = await getProjectFolderAccess(session, input.projectId, project.collectionName)
  if (!current.isVisible(input.folderId)) throw new NotFoundError('Folder not found')
  // The level before the project ceiling: `project:manage` was asked above, and
  // a manager is who this change is for.
  if (current.levelOf(input.folderId) !== 'write') throw folderReadOnlyError()

  const grants = input.access.mode === 'custom' ? await validatedGrants(session.organizationId, input.access.grants) : null
  // Folders not every member may read do not hold IFC models until their
  // building data is partitioned (ADR-0078): refused before anything changes.
  await assertRestrictionKeepsIfcOpen(session.organizationId, input.projectId, input.folderId, grants)

  const db = getDb()
  const updated = await withTenant({ organizationId: session.organizationId }, () =>
    // One transaction: the 0108 trigger checks at commit that a custom list is
    // never empty, so the old list may go before the new one arrives.
    db.transaction(async (tx) => {
      await tx.delete(projectFolderGrants).where(eq(projectFolderGrants.folderId, input.folderId))
      const rows = await tx
        .update(projectFolders)
        .set({
          accessMode: grants ? 'custom' : 'inherit',
          accessChangedBy: session.userId,
          accessChangedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projectFolders.id, input.folderId),
            eq(projectFolders.projectId, input.projectId),
            isNull(projectFolders.deletedAt)
          )
        )
        .returning({ id: projectFolders.id })
      if (rows.length === 0 || !grants) return rows
      await tx.insert(projectFolderGrants).values(
        grants.map((grant) => ({
          organizationId: session.organizationId,
          projectId: input.projectId,
          folderId: input.folderId,
          roleSlug: grant.role,
          level: grant.level,
        }))
      )
      return rows
    })
  )
  if (updated.length === 0) throw new NotFoundError('Folder not found')

  const placement = await placeProjectDocuments(session.organizationId, input.projectId)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.folder.access_changed',
    targetType: 'project',
    targetId: input.projectId,
    metadata: {
      folderId: input.folderId,
      mode: grants ? 'custom' : 'inherit',
      grants: grants ? describeGrants(grants) : '',
      // The roles alone, as the 0104 entries named them, so a reader of the
      // trail across the change finds the same field.
      roles: (grants ?? []).map((grant) => grant.role).join(','),
      documentsMoved: placement.moved,
    },
    request,
  })
  return { folderId: input.folderId, access: grants ? { mode: 'custom', grants } : { mode: 'inherit' }, ...placement }
}
