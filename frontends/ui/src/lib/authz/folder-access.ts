/**
 * Who may see which folders of a project (ADR-0078) — the one place that
 * decides.
 *
 * A folder may be restricted to WorkOS roles (`project_folders.restricted_roles`).
 * A member is cleared for a folder when they hold `org:projects:administer`
 * (organization admins see everything) or, for EVERY restricted folder on its
 * path, at least one of the roles it names. A folder they are not cleared for
 * is hidden, and so is everything below it — including what is filed there
 * later, because the answer is computed from the path at read time.
 *
 * Retrieval follows from the same answer: a document under a restricted folder
 * lives in the collection of its NEAREST restricted folder
 * ({@link restrictedCollectionName}), and only cleared members get that
 * collection in their signed scope. So this module answers both questions the
 * rest of the BFF asks: "may this session see the row?" and "which collections
 * may this session's turn search?".
 *
 * The core is pure ({@link computeFolderAccess}); {@link getProjectFolderAccess}
 * loads it, and costs one indexed query when the project restricts nothing —
 * which is nearly every project.
 */

import 'server-only'
import { rolesOf, type AuthorizedSession } from '@/lib/auth/types'
import { hasPermission, ORG_PERMISSIONS } from './permissions'
import {
  listProjectFolderTree,
  listRestrictedFolderNames,
  projectHasRestrictedFolders,
} from './folder-access-repository'

/** What the decision needs of a folder. */
export interface AccessFolder {
  id: string
  parentId: string | null
  restrictedRoles: readonly string[] | null
}

/** Who is asking, reduced to what clears a folder. */
export interface FolderClearance {
  roles: readonly string[]
  /** `org:projects:administer`: every folder is visible. */
  seesEverything: boolean
}

export interface ProjectFolderAccess {
  /** Folders hidden from this session: not cleared, or below one that is not. */
  readonly hiddenFolderIds: ReadonlySet<string>
  /** Whether a document filed in `folderId` (null: the project root) is visible. */
  isVisible(folderId: string | null): boolean
  /** The retrieval collection a document filed in `folderId` belongs in. */
  collectionFor(folderId: string | null): string
  /** The restricted collections this session's chat turns may search. */
  readonly clearedRestrictedCollections: readonly string[]
  /** Whether the project restricts anything at all; false is the fast path. */
  readonly anyRestricted: boolean
}

/**
 * The collection of a restricted folder: the project's own collection name with
 * `_r` and twelve hex digits of the folder id. 55 characters for the usual
 * `proj_<uuid>` base, inside every validator on the Python side (Chroma allows
 * 512), and still `proj_`-prefixed, so a reader that classifies by prefix
 * reads it as the project shelf.
 */
export function restrictedCollectionName(projectCollection: string, folderId: string): string {
  return `${projectCollection}_r${folderId.replace(/-/g, '').slice(0, 12).toLowerCase()}`
}

/** True when `collection` is one of the restricted collections of `projectCollection`. */
export function isRestrictedCollectionOf(projectCollection: string, collection: string): boolean {
  return collection.startsWith(`${projectCollection}_r`) && /^[0-9a-f]{12}$/.test(collection.slice(projectCollection.length + 2))
}

/**
 * The project collection a restricted collection belongs to, or null when
 * `collection` is not shaped like one. The inverse of
 * {@link restrictedCollectionName}, for a caller that holds only the name (the
 * collection proxy); whether that project exists, and whether the session is
 * cleared for the collection, is still the caller's to ask.
 */
export function restrictedCollectionBase(collection: string): string | null {
  const match = /^(.+)_r[0-9a-f]{12}$/.exec(collection)
  return match ? match[1] : null
}

const OPEN_ACCESS = (projectCollection: string): ProjectFolderAccess => ({
  hiddenFolderIds: new Set(),
  isVisible: () => true,
  collectionFor: () => projectCollection,
  clearedRestrictedCollections: [],
  anyRestricted: false,
})

/** The pure decision, over a project's whole folder tree. */
export function computeFolderAccess(
  folders: readonly AccessFolder[],
  clearance: FolderClearance,
  projectCollection: string
): ProjectFolderAccess {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const held = new Set(clearance.roles)
  const clears = (folder: AccessFolder): boolean =>
    clearance.seesEverything || (folder.restrictedRoles ?? []).some((role) => held.has(role))

  const hidden = new Set<string>()
  const nearestRestricted = new Map<string, string | null>()
  for (const folder of folders) {
    let nearest: string | null = null
    let visible = true
    // Walk to the root; a cycle cannot exist (the parent FK is acyclic by
    // construction), but the guard keeps a corrupt row from hanging a request.
    const seen = new Set<string>()
    for (let current: AccessFolder | undefined = folder; current && !seen.has(current.id); ) {
      seen.add(current.id)
      if (current.restrictedRoles && current.restrictedRoles.length > 0) {
        nearest ??= current.id
        if (!clears(current)) visible = false
      }
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    nearestRestricted.set(folder.id, nearest)
    if (!visible) hidden.add(folder.id)
  }

  const restrictedIds = folders.filter((folder) => folder.restrictedRoles && folder.restrictedRoles.length > 0)
  if (restrictedIds.length === 0) return OPEN_ACCESS(projectCollection)

  const cleared = restrictedIds
    .filter((folder) => !hidden.has(folder.id))
    .map((folder) => restrictedCollectionName(projectCollection, folder.id))

  return {
    hiddenFolderIds: hidden,
    // A folder this tree does not know (deleted meanwhile) is treated as hidden:
    // the safe direction for a row that names it.
    isVisible: (folderId) => folderId === null || (byId.has(folderId) && !hidden.has(folderId)),
    collectionFor: (folderId) => {
      const nearest = folderId ? nearestRestricted.get(folderId) : null
      return nearest ? restrictedCollectionName(projectCollection, nearest) : projectCollection
    },
    clearedRestrictedCollections: [...new Set(cleared)],
    anyRestricted: true,
  }
}

/** What clears folders for this session. */
export function clearanceOf(session: AuthorizedSession): FolderClearance {
  return {
    roles: rolesOf(session),
    seesEverything: hasPermission(session, ORG_PERMISSIONS.projectsAdminister),
  }
}

/**
 * The session's access to one project's folders. The caller has already
 * authorized the project itself (`requireProjectAccess`); this narrows within it.
 */
export async function getProjectFolderAccess(
  session: AuthorizedSession,
  projectId: string,
  projectCollection: string
): Promise<ProjectFolderAccess> {
  if (!(await projectHasRestrictedFolders(session.organizationId, projectId))) {
    return OPEN_ACCESS(projectCollection)
  }
  const folders = await listProjectFolderTree(session.organizationId, projectId)
  return computeFolderAccess(folders, clearanceOf(session), projectCollection)
}

/**
 * The folders of a project hidden from this session — what a listing excludes.
 * Empty for a project that restricts nothing, at the cost of one probe.
 */
export async function getHiddenFolderIds(session: AuthorizedSession, projectId: string): Promise<string[]> {
  if (!(await projectHasRestrictedFolders(session.organizationId, projectId))) return []
  const folders = await listProjectFolderTree(session.organizationId, projectId)
  // The collection name plays no part in which folders are hidden.
  return [...computeFolderAccess(folders, clearanceOf(session), '').hiddenFolderIds]
}

/**
 * Every folder of a project that sits under a restriction — what a caller with
 * no session to clear (the agent's service-token routes) must treat as hidden.
 * The answer for someone who holds no role and is not an admin, so it fails
 * closed. Empty for a project that restricts nothing, at the cost of one probe.
 */
export async function getRestrictedFolderIds(organizationId: string, projectId: string): Promise<string[]> {
  if (!(await projectHasRestrictedFolders(organizationId, projectId))) return []
  const folders = await listProjectFolderTree(organizationId, projectId)
  return [...computeFolderAccess(folders, { roles: [], seesEverything: false }, '').hiddenFolderIds]
}

/** Whether a row filed in `folderId` (null: the project root) is visible to this session. */
export async function isFolderVisibleTo(
  session: AuthorizedSession,
  projectId: string,
  folderId: string | null
): Promise<boolean> {
  // Nothing about the session is read until a restriction is in play: an
  // unfiled document, or a project that restricts nothing, is the common case.
  if (folderId === null) return true
  return isFolderVisibleToClearance(session.organizationId, projectId, folderId, clearanceOf(session))
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
  if (folderId === null || clearance.seesEverything) return true
  if (!(await projectHasRestrictedFolders(organizationId, projectId))) return true
  const folders = await listProjectFolderTree(organizationId, projectId)
  return computeFolderAccess(folders, clearance, '').isVisible(folderId)
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
  if (folderId === null || !(await projectHasRestrictedFolders(organizationId, projectId))) return projectCollection
  const folders = await listProjectFolderTree(organizationId, projectId)
  return computeFolderAccess(folders, { roles: [], seesEverything: true }, projectCollection).collectionFor(folderId)
}

/**
 * The collections of every restricted folder on `folderId`'s path, itself
 * included: what a member must be cleared for to see a document filed there.
 *
 * Clearance for a folder is a role for EVERY restricted folder on its path
 * (`computeFolderAccess`), and clearance for a restricted collection is
 * clearance for its folder, whose path is a prefix of this one. So anyone who
 * can read a document in `folderId` is cleared for each collection listed here,
 * and content drawn from those collections, and from no others, reaches nobody
 * new when it is filed there (`lib/conversations/restricted-egress.ts`). A root
 * folder, or an unknown id, lists nothing: it is open.
 */
export function restrictedCollectionsOnPath(
  folders: readonly AccessFolder[],
  projectCollection: string,
  folderId: string | null
): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const collections: string[] = []
  const seen = new Set<string>()
  for (let current = folderId ? byId.get(folderId) : undefined; current && !seen.has(current.id); ) {
    seen.add(current.id)
    if (current.restrictedRoles && current.restrictedRoles.length > 0) {
      collections.push(restrictedCollectionName(projectCollection, current.id))
    }
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return collections
}

/** {@link restrictedCollectionsOnPath} for a stored folder; one probe for a project that restricts nothing. */
export async function restrictedCollectionsAbove(
  organizationId: string,
  projectId: string,
  projectCollection: string,
  folderId: string | null
): Promise<string[]> {
  if (folderId === null || !(await projectHasRestrictedFolders(organizationId, projectId))) return []
  const folders = await listProjectFolderTree(organizationId, projectId)
  return restrictedCollectionsOnPath(folders, projectCollection, folderId)
}

/**
 * Every CURRENT restricted collection of a project, whoever asks: what a stored
 * restriction (a memory item, ADR-0078) is validated and served against. A
 * collection missing from this list belongs to a restriction that was lifted or
 * a folder that was deleted, and clears nobody. Empty for a project that
 * restricts nothing, at the cost of one probe.
 */
export async function currentRestrictedCollections(
  organizationId: string,
  projectId: string,
  projectCollection: string
): Promise<string[]> {
  if (!(await projectHasRestrictedFolders(organizationId, projectId))) return []
  const folders = await listProjectFolderTree(organizationId, projectId)
  return [
    ...computeFolderAccess(folders, { roles: [], seesEverything: true }, projectCollection)
      .clearedRestrictedCollections,
  ]
}

/**
 * The name of each current restricted folder, keyed by its collection: how a
 * surface names a restriction to someone already cleared for it (the memory
 * panel's lock). Never call it to decide access.
 */
export async function restrictedFolderNamesByCollection(
  organizationId: string,
  projectId: string,
  projectCollection: string
): Promise<Map<string, string>> {
  const folders = await listRestrictedFolderNames(organizationId, projectId)
  return new Map(folders.map((folder) => [restrictedCollectionName(projectCollection, folder.id), folder.name]))
}
