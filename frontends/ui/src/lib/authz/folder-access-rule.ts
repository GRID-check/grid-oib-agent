/**
 * The pure core of folder access (ADR-0087): the rule over a path, the project
 * ceiling, which folders restrict reading and which collection a document
 * belongs in. No I/O and no session: `./folder-access` loads the tree and
 * re-exports everything here, and that is the module callers import.
 *
 * Kept apart so a spec that mocks the loaders keeps the real rule
 * (`@/test-utils/folder-access`).
 */

import { ForbiddenError } from '@/lib/api/errors'

/** The reserved role slug of a grant to every member of the project. */
export const EVERY_PROJECT_MEMBER = '*'

/** What a grant lets a role do: read, or read and write. */
export type FolderGrantLevel = 'read' | 'write'

/** What someone may do in a folder. */
export type FolderLevel = 'none' | FolderGrantLevel

/** One entry of a folder's own access list. */
export interface FolderGrant {
  role: string
  level: FolderGrantLevel
}

/**
 * Who sees what was derived from a folder once its purge has run, by the
 * organization's „Inhalte aus gelöschten Ordnern" setting:
 *
 * - `unchanged` (default): whoever could read the folder, by its kept grants;
 * - `project`: every project member;
 * - `admins`: organization admins only;
 * - `remove`: the purge removed it with the folder; anything that
 *   survived is for admins only.
 */
export const DELETED_FOLDER_CONTENT_POLICIES = ['unchanged', 'project', 'admins', 'remove'] as const
export type DeletedFolderContentPolicy = (typeof DELETED_FOLDER_CONTENT_POLICIES)[number]

/** What the decision needs of a folder. */
export interface AccessFolder {
  id: string
  parentId: string | null
  accessMode: 'inherit' | 'custom'
  /** The folder's own list; read only when `accessMode` is `custom`. */
  grants: readonly FolderGrant[]
  /** Deleted: in the Papierkorb or a tombstone. Hidden everywhere, and so is what is filed in it; still answered for. */
  deleted?: boolean
  /** When the purge ran: a permanent tombstone. Unset for a living folder and one in the bin. */
  purgedAt?: Date | null
  /** The organization's setting for content derived from a purged folder; read only with `purgedAt`. */
  purgedContent?: DeletedFolderContentPolicy
}

/** Who is asking, reduced to what the grants are matched against. */
export interface FolderClearance {
  roles: readonly string[]
  /** `org:projects:administer`: every folder, written. */
  seesEverything: boolean
}

/** The permissions that let a session change a project's documents at all: the write ceiling. */
export const DOCUMENT_WRITE_PERMISSIONS = ['project:documents:write', 'project:edit'] as const

/** The machine-readable reason a write into a read-only folder is refused. */
export const FOLDER_READ_ONLY_REASON = 'folder-read-only'

const RANK: Readonly<Record<FolderLevel, number>> = { none: 0, read: 1, write: 2 }

const lower = (a: FolderLevel, b: FolderLevel): FolderLevel => (RANK[a] <= RANK[b] ? a : b)
const higher = (a: FolderLevel, b: FolderLevel): FolderLevel => (RANK[a] >= RANK[b] ? a : b)

/** Whether `level` allows at least `needed`. */
export function atLeast(level: FolderLevel, needed: FolderGrantLevel): boolean {
  return RANK[level] >= RANK[needed]
}

/** What one folder's own list grants a clearance: the best entry naming one of its roles, or `*`. */
export function listLevel(grants: readonly FolderGrant[], clearance: FolderClearance): FolderLevel {
  const held = new Set(clearance.roles)
  let level: FolderLevel = 'none'
  for (const grant of grants) {
    if (grant.role === EVERY_PROJECT_MEMBER || held.has(grant.role)) level = higher(level, grant.level)
  }
  return level
}

/** The folder tree keyed by id, for the walks below. */
export type FolderTree = ReadonlyMap<string, AccessFolder>

export function folderTree(folders: readonly AccessFolder[]): FolderTree {
  return new Map(folders.map((folder) => [folder.id, folder]))
}

/**
 * THE rule: the level `clearance` has on `folderId`, before the project ceiling.
 *
 * The project root (null) is `write`: the project's permissions decide. A
 * folder is the minimum over itself and every ancestor that has its own list;
 * an ancestor that inherits contributes nothing. An organization admin writes
 * everywhere the folder exists. A folder this tree does not know, or a path
 * that breaks off (a parent the tree does not hold), is `none`: the safe
 * direction for a row that names it. A deleted folder's tombstone answers like
 * a living folder, from its stored parent and grants, until it is purged: then
 * the organization's {@link DeletedFolderContentPolicy} decides (`unchanged`
 * keeps the grants, `project` lets every member read, `admins` and `remove`
 * leave it to organization admins).
 */
export function effectiveFolderLevel(tree: FolderTree, clearance: FolderClearance, folderId: string | null): FolderLevel {
  if (folderId === null) return 'write'
  const target = tree.get(folderId)
  if (!target) return 'none'
  if (clearance.seesEverything) return 'write'
  // A purged folder's derived content follows the organization's setting
  // (ADR-0087); `unchanged` reads the kept grants below.
  const purgedPolicy = target.purgedAt ? (target.purgedContent ?? 'unchanged') : 'unchanged'
  if (purgedPolicy === 'project') return 'read'
  if (purgedPolicy === 'admins' || purgedPolicy === 'remove') return 'none'
  let level: FolderLevel = 'write'
  // A cycle cannot exist (the parent FK is acyclic by construction), but the
  // guard keeps a corrupt row from hanging a request.
  const seen = new Set<string>()
  for (let current = tree.get(folderId); current; ) {
    if (seen.has(current.id)) return 'none'
    seen.add(current.id)
    if (current.accessMode === 'custom') level = lower(level, listLevel(current.grants, clearance))
    if (level === 'none' || current.parentId === null) return level
    const parent = tree.get(current.parentId)
    if (!parent) return 'none'
    current = parent
  }
  return level
}

/**
 * The living folders below `folderId`, at any depth, that `clearance` may not
 * read. What a change that decides who reads a whole subtree (a move) must not
 * make blind: the folders it cannot see are the ones whose readers it would
 * change without knowing.
 */
export function unreadableFoldersBelow(tree: FolderTree, clearance: FolderClearance, folderId: string): string[] {
  const isBelow = (folder: AccessFolder): boolean => {
    const seen = new Set<string>([folder.id])
    for (let parent = folder.parentId; parent !== null && !seen.has(parent); parent = tree.get(parent)?.parentId ?? null) {
      if (parent === folderId) return true
      seen.add(parent)
    }
    return false
  }
  return [...tree.values()]
    .filter((folder) => !folder.deleted && isBelow(folder))
    .filter((folder) => !atLeast(effectiveFolderLevel(tree, clearance, folder.id), 'read'))
    .map((folder) => folder.id)
}

/** The project permission caps writing: without it, `write` is `read`. */
export function withProjectCeiling(level: FolderLevel, projectMayWrite: boolean): FolderLevel {
  return level === 'write' && !projectMayWrite ? 'read' : level
}

/** Whether a folder's own list leaves some project member unable to read it: `custom` without `*`. */
export function restrictsReading(folder: AccessFolder): boolean {
  return folder.accessMode === 'custom' && !folder.grants.some((grant) => grant.role === EVERY_PROJECT_MEMBER)
}

/** Someone who holds no role and is not an admin: what every project member can do. */
export const ANY_MEMBER: FolderClearance = { roles: [], seesEverything: false }

/** Whether every member of the project can read `folderId` (a tombstone included). False for an unknown id. */
export function readableByEveryMember(tree: FolderTree, folderId: string): boolean {
  return atLeast(effectiveFolderLevel(tree, ANY_MEMBER, folderId), 'read')
}

/**
 * The living folders whose own list names no role that exists and not `*`:
 * the list matches nobody, so only organization admins read them (the rule
 * above gives a non-admin `none`). What is left of a folder when the role it
 * named is deleted in WorkOS; the project settings flag it so someone sets a
 * role again. A rename keeps the slug and so never lands a folder here.
 */
export function foldersWithoutValidRole(folders: readonly AccessFolder[], existingRoles: ReadonlySet<string>): string[] {
  return folders
    .filter(
      (folder) =>
        !folder.deleted &&
        folder.accessMode === 'custom' &&
        !folder.grants.some((grant) => grant.role === EVERY_PROJECT_MEMBER || existingRoles.has(grant.role))
    )
    .map((folder) => folder.id)
}

/** The folders on `folderId`'s path, itself first, that restrict reading. Empty for the root or an unknown id. */
export function readRestrictingFoldersOnPath(tree: FolderTree, folderId: string | null): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (let current = folderId ? tree.get(folderId) : undefined; current && !seen.has(current.id); ) {
    seen.add(current.id)
    if (restrictsReading(current)) found.push(current.id)
    current = current.parentId ? tree.get(current.parentId) : undefined
  }
  return found
}

/**
 * Whether `folderId`, or an ancestor, has its own access list, whatever it
 * grants (`custom`, with or without `*`). The test the download log applies to
 * an OPEN: such a folder is one an office chose to treat apart. False for the
 * project root and for an id the tree does not hold.
 */
export function isUnderOwnList(tree: FolderTree, folderId: string | null): boolean {
  const seen = new Set<string>()
  for (let current = folderId ? tree.get(folderId) : undefined; current && !seen.has(current.id); ) {
    if (current.accessMode === 'custom') return true
    seen.add(current.id)
    current = current.parentId ? tree.get(current.parentId) : undefined
  }
  return false
}

export interface ProjectFolderAccess {
  /**
   * Folders this clearance may not read, and every deleted folder (in the
   * Papierkorb or a tombstone): not listed, and nothing filed in them is either.
   */
  readonly hiddenFolderIds: ReadonlySet<string>
  /** Whether a document filed in `folderId` (null: the project root) may be read. A tombstone never is. */
  isVisible(folderId: string | null): boolean
  /** The level on a folder before the project ceiling; tombstones included. */
  levelOf(folderId: string | null): FolderLevel
  /** The retrieval collection a document filed in `folderId` belongs in. */
  collectionFor(folderId: string | null): string
  /** The folder whose collection `collection` is, when it is one of this project's restricted collections. */
  sourceFolderOf(collection: string): string | null
  /** The restricted collections this clearance may read: what its chat turns may search. */
  readonly clearedRestrictedCollections: readonly string[]
  /** Whether a folder hides rows from someone: a living one with its own list, or one in the bin. False is the fast path. */
  readonly anyRestricted: boolean
}

/**
 * The collection of a folder that restricts reading: the project's own
 * collection name with `_r` and twelve hex digits of the folder id. 55
 * characters for the usual `proj_<uuid>` base, inside every validator on the
 * Python side (Chroma allows 512), and still `proj_`-prefixed, so a reader that
 * classifies by prefix reads it as the project shelf.
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
 * collection proxy); whether that project exists, and whether the session may
 * read the collection, is still the caller's to ask.
 */
export function restrictedCollectionBase(collection: string): string | null {
  const match = /^(.+)_r[0-9a-f]{12}$/.exec(collection)
  return match ? match[1] : null
}

/** The open answer: no folder has its own list, so every folder is what the project makes it. */
export const OPEN_ACCESS = (projectCollection: string, tree: FolderTree = new Map()): ProjectFolderAccess => ({
  hiddenFolderIds: new Set([...tree.values()].filter((folder) => folder.deleted).map((folder) => folder.id)),
  isVisible: (folderId) => folderId === null || tree.size === 0 || (tree.has(folderId) && !tree.get(folderId)?.deleted),
  levelOf: (folderId) => (folderId === null || tree.size === 0 || tree.has(folderId) ? 'write' : 'none'),
  collectionFor: () => projectCollection,
  sourceFolderOf: () => null,
  clearedRestrictedCollections: [],
  anyRestricted: false,
})

/** The pure decision, over a project's whole folder tree (tombstones included). */
export function computeFolderAccess(
  folders: readonly AccessFolder[],
  clearance: FolderClearance,
  projectCollection: string
): ProjectFolderAccess {
  const tree = folderTree(folders)
  const living = folders.filter((folder) => !folder.deleted)
  if (!folders.some((folder) => folder.accessMode === 'custom' || folder.deleted)) return OPEN_ACCESS(projectCollection, tree)
  const levels = new Map(folders.map((folder) => [folder.id, effectiveFolderLevel(tree, clearance, folder.id)]))
  const levelOf = (folderId: string | null): FolderLevel =>
    folderId === null ? 'write' : (levels.get(folderId) ?? 'none')

  // A deleted folder hides what is filed in it from everyone, admins included:
  // the Papierkorb is the one place it is seen.
  const hidden = new Set(
    folders.filter((folder) => folder.deleted || !atLeast(levelOf(folder.id), 'read')).map((folder) => folder.id)
  )
  const nearestRestricting = new Map(living.map((folder) => [folder.id, readRestrictingFoldersOnPath(tree, folder.id)[0] ?? null]))
  const restricting = living.filter(restrictsReading)
  const bySourceCollection = new Map(
    restricting.map((folder) => [restrictedCollectionName(projectCollection, folder.id), folder.id])
  )

  return {
    hiddenFolderIds: hidden,
    // A folder this tree does not know (deleted meanwhile) or a tombstone is
    // not visible: the safe direction for a row that names it.
    isVisible: (folderId) =>
      folderId === null || (tree.has(folderId) && !tree.get(folderId)?.deleted && !hidden.has(folderId)),
    levelOf,
    collectionFor: (folderId) => {
      const nearest = folderId ? nearestRestricting.get(folderId) : null
      return nearest ? restrictedCollectionName(projectCollection, nearest) : projectCollection
    },
    sourceFolderOf: (collection) => bySourceCollection.get(collection) ?? null,
    clearedRestrictedCollections: restricting
      .filter((folder) => atLeast(levelOf(folder.id), 'read'))
      .map((folder) => restrictedCollectionName(projectCollection, folder.id)),
    anyRestricted: living.some((folder) => folder.accessMode === 'custom') || folders.some((folder) => folder.deleted && !folder.purgedAt),
  }
}

/**
 * The folders `access` hides because its clearance may not read them, tombstones
 * included, as against the ones hidden from everyone only because they are in
 * the Papierkorb ({@link ProjectFolderAccess.hiddenFolderIds} holds both). A
 * reader who may read a binned folder learns nothing about it from a count that
 * includes its files; one who may not would. Empty for an organization admin.
 */
export function unreadableFolderIds(access: ProjectFolderAccess): string[] {
  return [...access.hiddenFolderIds].filter((folderId) => !atLeast(access.levelOf(folderId), 'read'))
}

/** The machine-readable reason a move is refused because the subtree holds a folder the mover cannot read. */
export const FOLDER_SUBTREE_UNREADABLE_REASON = 'folder-subtree-unreadable'

/**
 * The refusal of a move that would change who reads a subtree containing a
 * folder the mover cannot read. It names no folder: the mover may not know it
 * exists.
 */
export function folderSubtreeUnreadableError(): ForbiddenError {
  return new ForbiddenError(
    'This folder contains folders you cannot read, so you cannot change who may read it. Ask an organization admin to move it.',
    { reason: FOLDER_SUBTREE_UNREADABLE_REASON }
  )
}

/** The refusal of a write into a folder the session may read but not write. */
export function folderReadOnlyError(): ForbiddenError {
  return new ForbiddenError('You can read this folder but not change it.', { reason: FOLDER_READ_ONLY_REASON })
}
