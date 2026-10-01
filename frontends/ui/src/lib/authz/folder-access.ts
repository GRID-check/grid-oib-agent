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
import { listProjectFolderTree, projectHasRestrictedFolders } from './folder-access-repository'

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
