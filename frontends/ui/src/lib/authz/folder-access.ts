/**
 * Who may read and who may write which folders of a project (ADR-0080,
 * ADR-0081) — the one place that decides.
 *
 * A folder either inherits its parent's access (`accessMode: 'inherit'`; a root
 * folder inherits the project) or has its own access list (`'custom'`): grants
 * of `read` or `write` to WorkOS role slugs, and `*` for every project member.
 * A role not listed gets nothing.
 *
 * ONE rule over a path, {@link effectiveFolderLevel}: the level on a folder is
 * the minimum over the folder and every ancestor that has its own list, so a
 * subfolder can be narrower than its parent and never wider. Organization
 * admins (`org:projects:administer`) write everywhere. The project permission
 * is the ceiling for writing ({@link withProjectCeiling}): a project viewer
 * granted `write` on a folder still only reads.
 *
 * Retrieval keys on READ. A folder that not every project member can read — a
 * custom list without `*` — gets its own collection
 * ({@link restrictedCollectionName}), and a document lives in the collection
 * of its NEAREST such folder. Only a session that may read that folder gets the
 * collection in its signed scope. Write never affects retrieval.
 *
 * Deleted folders stay in the tree as tombstones (migration 0110): they are
 * hidden from every listing and from placement, and {@link effectiveFolderLevel}
 * still answers for them, because content derived from a deleted folder is
 * judged by the access it had.
 *
 * The core is pure ({@link effectiveFolderLevel}, {@link computeFolderAccess});
 * the loaders cost one indexed probe when the project has no custom folder,
 * which is nearly every project.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { rolesOf, type AuthorizedSession } from '@/lib/auth/types'
import { hasPermission, ORG_PERMISSIONS } from './permissions'
import { orgRoleHoldsPermission } from './org-role-permissions'
import { resolveMembershipRoles } from '@/lib/auth/membership-roles'
import { requireProjectAccess } from './projects'
import { listCustomFolderNames, listProjectFolderTree, projectHasCustomFolders } from './folder-access-repository'
import {
  ANY_MEMBER,
  atLeast,
  computeFolderAccess,
  DOCUMENT_WRITE_PERMISSIONS,
  effectiveFolderLevel,
  folderReadOnlyError,
  folderTree,
  OPEN_ACCESS,
  type AccessFolder,
  type FolderClearance,
  type ProjectFolderAccess,
} from './folder-access-rule'

export * from './folder-access-rule'

/**
 * Whether any of `roles` holds the admin bypass in the organization, by what
 * WorkOS and the catalog say each role holds now (`orgRoleHoldsPermission`,
 * cached at most a minute).
 */
async function anyRoleAdministers(organizationId: string, roles: readonly string[]): Promise<boolean> {
  const verdicts = await Promise.all(
    roles.map((role) => orgRoleHoldsPermission(role, ORG_PERMISSIONS.projectsAdminister, organizationId))
  )
  return verdicts.some(Boolean)
}

/**
 * What clears folders for this session: its roles and the admin bypass.
 *
 * The bypass comes from the same membership the roles do, at most a minute old
 * (`resolveMembershipRoles`, then what those roles hold), not from the token's
 * `permissions` claim. The token lives until it is refreshed, so an admin
 * demoted in the People tab kept reading and writing every folder for that
 * long. Only when WorkOS cannot be asked is the token's claim the answer, as it
 * is for the roles.
 */
export async function clearanceOf(session: AuthorizedSession): Promise<FolderClearance> {
  const roles = rolesOf(session)
  const current = await resolveMembershipRoles(session.organizationId, session.userId)
  if (current === null) return { roles, seesEverything: hasPermission(session, ORG_PERMISSIONS.projectsAdminister) }
  return { roles, seesEverything: await anyRoleAdministers(session.organizationId, current) }
}

/** The project's folder tree, or null when no folder (living or deleted) has its own list. */
export async function loadCustomFolderTree(organizationId: string, projectId: string): Promise<AccessFolder[] | null> {
  if (!(await projectHasCustomFolders(organizationId, projectId))) return null
  return listProjectFolderTree(organizationId, projectId)
}

/**
 * The session's access to one project's folders, before the project ceiling.
 * The caller has already authorized the project itself (`requireProjectAccess`);
 * this narrows within it.
 */
export async function getProjectFolderAccess(
  session: AuthorizedSession,
  projectId: string,
  projectCollection: string
): Promise<ProjectFolderAccess> {
  const folders = await loadCustomFolderTree(session.organizationId, projectId)
  if (!folders) return OPEN_ACCESS(projectCollection)
  return computeFolderAccess(folders, await clearanceOf(session), projectCollection)
}

/**
 * The folders of a project hidden from this session — what a listing excludes.
 * Empty for a project with no custom folder, at the cost of one probe.
 */
export async function getHiddenFolderIds(session: AuthorizedSession, projectId: string): Promise<string[]> {
  const folders = await loadCustomFolderTree(session.organizationId, projectId)
  if (!folders) return []
  return [...computeFolderAccess(folders, await clearanceOf(session), '').hiddenFolderIds]
}

/**
 * Every living folder of a project that not every member can read — what a
 * caller with no session to clear (the agent's service-token routes) must treat
 * as hidden. The answer for someone who holds no role and is not an admin, so
 * it fails closed. Empty for a project with no custom folder.
 */
export async function getRestrictedFolderIds(organizationId: string, projectId: string): Promise<string[]> {
  const folders = await loadCustomFolderTree(organizationId, projectId)
  if (!folders) return []
  return [...computeFolderAccess(folders, ANY_MEMBER, '').hiddenFolderIds]
}

/** Whether a row filed in `folderId` (null: the project root) may be read by this session. */
export async function isFolderVisibleTo(
  session: AuthorizedSession,
  projectId: string,
  folderId: string | null
): Promise<boolean> {
  // Nothing about the session is read until a restriction is in play: an
  // unfiled document, or a project with no custom folder, is the common case.
  if (folderId === null) return true
  return isFolderVisibleToClearance(session.organizationId, projectId, folderId, await clearanceOf(session))
}

/**
 * {@link isFolderVisibleTo} for someone who is not the session: a member the
 * BFF is deciding about on its own (who to notify), from the roles WorkOS
 * reports for their membership.
 */
export async function isFolderVisibleToClearance(
  organizationId: string,
  projectId: string,
  folderId: string | null,
  clearance: FolderClearance
): Promise<boolean> {
  if (folderId === null) return true
  const folders = await loadCustomFolderTree(organizationId, projectId)
  if (!folders) return true
  return computeFolderAccess(folders, clearance, '').isVisible(folderId)
}

/**
 * Which of `userIds` may read `folderId` (null: the project root) now, each by
 * the roles WorkOS reports for their membership. For a caller that picks other
 * people for something filed in a folder (who is asked to review a version):
 * someone who may not open the folder cannot open what they were asked about.
 * Reads the tree once, and not at all for the root or a project with no own
 * list. Fails closed per person, as {@link clearanceOfMember} does.
 */
export async function filterUsersWhoMayReadFolder(
  organizationId: string,
  projectId: string,
  folderId: string | null,
  userIds: readonly string[]
): Promise<Set<string>> {
  if (folderId === null || userIds.length === 0) return new Set(userIds)
  const folders = await loadCustomFolderTree(organizationId, projectId)
  if (!folders) return new Set(userIds)
  const clearances = await Promise.all(userIds.map((userId) => clearanceOfMember(organizationId, userId)))
  return new Set(
    userIds.filter((_userId, index) => computeFolderAccess(folders, clearances[index], '').isVisible(folderId))
  )
}

/** Whether the session may change the project's documents at all: the write ceiling. Never throws. */
export async function projectMayWriteDocuments(session: AuthorizedSession, projectId: string): Promise<boolean> {
  try {
    await requireProjectAccess(session, projectId, DOCUMENT_WRITE_PERMISSIONS)
    return true
  } catch (error) {
    if (error instanceof NotFoundError) return false
    throw error
  }
}

/**
 * THE write check, server side: every path that changes a folder or what is
 * filed in it asks this, for every folder it touches (null: the project root).
 *
 * The project's document-write permission first (`requireProjectAccess`, 404
 * without it: the ceiling), then each folder: one the session may not read is
 * not found, one it may only read is refused with a typed 403
 * (`details.reason` {@link FOLDER_READ_ONLY_REASON}).
 */
export async function requireFolderWrite(
  session: AuthorizedSession,
  projectId: string,
  folderIds: readonly (string | null)[]
): Promise<void> {
  await requireProjectAccess(session, projectId, DOCUMENT_WRITE_PERMISSIONS)
  const touched = [...new Set(folderIds)].filter((folderId): folderId is string => folderId !== null)
  if (touched.length === 0) return
  const folders = await loadCustomFolderTree(session.organizationId, projectId)
  const access = folders ? computeFolderAccess(folders, await clearanceOf(session), '') : OPEN_ACCESS('')
  for (const folderId of touched) {
    if (!access.isVisible(folderId)) throw new NotFoundError('Folder not found')
  }
  if (touched.some((folderId) => access.levelOf(folderId) !== 'write')) throw folderReadOnlyError()
}

/** {@link requireFolderWrite} as a yes or no, for a caller that only reflects it (a listing's affordances). */
export async function canWriteFolder(
  session: AuthorizedSession,
  projectId: string,
  folderId: string | null
): Promise<boolean> {
  try {
    await requireFolderWrite(session, projectId, [folderId])
    return true
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return false
    throw error
  }
}

/**
 * The collection a document filed in `folderId` belongs in, whoever asks — for
 * the writers that file on someone's behalf (a generated report) rather than
 * reading as them.
 */
export async function placementCollectionFor(
  organizationId: string,
  projectId: string,
  projectCollection: string,
  folderId: string | null
): Promise<string> {
  if (folderId === null) return projectCollection
  const folders = await loadCustomFolderTree(organizationId, projectId)
  if (!folders) return projectCollection
  return computeFolderAccess(folders, { roles: [], seesEverything: true }, projectCollection).collectionFor(folderId)
}

/**
 * Every CURRENT restricted collection of a project, whoever asks: the
 * collections of living folders that restrict reading. Empty for a project with
 * no custom folder, at the cost of one probe.
 */
export async function currentRestrictedCollections(
  organizationId: string,
  projectId: string,
  projectCollection: string
): Promise<string[]> {
  const folders = await loadCustomFolderTree(organizationId, projectId)
  if (!folders) return []
  return [
    ...computeFolderAccess(folders, { roles: [], seesEverything: true }, projectCollection)
      .clearedRestrictedCollections,
  ]
}

/**
 * The name of each folder with its own access list, keyed by its id,
 * tombstones included: how a surface names a restriction to someone who may
 * read it (the memory panel's lock). Never call it to decide access.
 */
export async function customFolderNames(organizationId: string, projectId: string): Promise<Map<string, string>> {
  const folders = await listCustomFolderNames(organizationId, projectId)
  return new Map(folders.map((folder) => [folder.id, folder.name]))
}

/**
 * What clears folders for a member who is not the session: someone a
 * conversation is shared with, or the asker of an agent turn. Read from the
 * roles WorkOS reports for their membership (cached for at most a minute), and
 * fails closed: no membership, or a lookup that failed, clears nothing.
 */
export async function clearanceOfMember(organizationId: string, userId: string): Promise<FolderClearance> {
  const roles = await resolveMembershipRoles(organizationId, userId)
  if (!roles || roles.length === 0) return { roles: [], seesEverything: false }
  return { roles, seesEverything: await anyRoleAdministers(organizationId, roles) }
}

/**
 * {@link isFolderVisibleToClearance} for a person named by id alone, read from
 * their membership as it is NOW: what a capability URL re-checks when it is used,
 * with no session at hand. The membership is only asked about when the project
 * has a folder with its own list, so a project without one costs the one probe
 * and no WorkOS call.
 */
export async function isFolderVisibleToMember(
  organizationId: string,
  projectId: string,
  folderId: string | null,
  userId: string
): Promise<boolean> {
  if (folderId === null) return true
  const folders = await loadCustomFolderTree(organizationId, projectId)
  if (!folders) return true
  const clearance = await clearanceOfMember(organizationId, userId)
  return computeFolderAccess(folders, clearance, '').isVisible(folderId)
}

/**
 * Every folder of a project (tombstones included) `clearance` may read now:
 * what content derived from folders — restricted memory — is served against
 * (`memoryVisibleTo`). Reads the whole tree, because a note may name a folder
 * that has since been opened, and an opened folder must open it.
 */
export async function readableFolderIdsFor(
  organizationId: string,
  projectId: string,
  clearance: FolderClearance
): Promise<string[]> {
  const folders = await listProjectFolderTree(organizationId, projectId)
  const tree = folderTree(folders)
  return folders
    .filter((folder) => atLeast(effectiveFolderLevel(tree, clearance, folder.id), 'read'))
    .map((folder) => folder.id)
}

/**
 * The source folder of each of `collections` that is a current restricted
 * collection of the project; a name that is not one is absent from the map.
 * How a writer that knows collections (the agent) names what it drew on.
 */
export async function sourceFoldersOfCollections(
  organizationId: string,
  projectId: string,
  projectCollection: string,
  collections: readonly string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (collections.length === 0) return found
  const folders = await loadCustomFolderTree(organizationId, projectId)
  if (!folders) return found
  const access = computeFolderAccess(folders, { roles: [], seesEverything: true }, projectCollection)
  for (const collection of collections) {
    const folderId = access.sourceFolderOf(collection)
    if (folderId) found.set(collection, folderId)
  }
  return found
}
