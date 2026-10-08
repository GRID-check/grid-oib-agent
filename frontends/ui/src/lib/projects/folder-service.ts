/**
 * A project's folders — the project half of the shelf-parameterised folder
 * core in `@/lib/documents/shelf-folders` (ADR-0078).
 *
 * Everything that makes a folder a folder lives there and is shared with the
 * org-wide Archiv, authorization included (`@/lib/documents/shelf-authz`:
 * `project:view` to read, `project:documents:write` or `project:edit` to
 * change). What is left here is the names and signatures a project's callers
 * know, and the one thing only a project's folders have: access per role
 * (ADR-0088). A folder the reader may not read, and everything below it, does
 * not exist for them; a write asks `requireFolderWrite` first; a move or delete
 * that changes who reads what needs `project:manage`, is audited, and moves
 * the documents into the collection their new access calls for. The Archiv's
 * twin is `@/lib/archiv/folder-service`.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import {
  clearanceOf,
  computeFolderAccess,
  folderReadOnlyError,
  folderSubtreeUnreadableError,
  getProjectFolderAccess,
  projectMayWriteDocuments,
  requireFolderWrite,
  unreadableFoldersBelow,
  withProjectCeiling,
  type AccessFolder,
  type FolderGrant,
} from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projectFolders } from '@/lib/db/schema'
import { projectShelf } from '@/lib/documents/shelf'
import {
  createShelfFolder,
  deleteShelfFolder,
  ensureShelfFolderPaths,
  findShelfFolder,
  findShelfRootFolder,
  getOrCreateShelfRootFolder,
  listShelfFolders,
  mirrorShelfFolderPathRewrite,
  updateShelfFolder,
  type FolderRow,
  type ShelfFolderVisibility,
} from '@/lib/documents/shelf-folders'
import { findProjectInOrg } from '@/lib/projects/repository'
import { and, eq, isNull } from 'drizzle-orm'
import { placeProjectDocuments } from './collection-placement'
import { describeGrants } from './folder-access-settings'
import { assertFolderMoveKeepsIfcOpen } from './ifc-folder-guard'

export { toFolderRow } from '@/lib/documents/shelf-folders'
export type { DeleteFolderResult, FolderRow } from '@/lib/documents/shelf-folders'

export interface CreateFolderInput {
  projectId: string
  parentId?: string | null
  name: string
}

export interface UpdateFolderInput {
  projectId: string
  folderId: string
  /** New name. Omitted leaves it alone. */
  name?: string
  /** New parent — `null` moves the folder to the project root. Omitted leaves it. */
  parentId?: string | null
}

export interface DeleteFolderInput {
  projectId: string
  folderId: string
}

export interface EnsureFolderPathsInput {
  projectId: string
  /** The level the paths are relative to. `null` is the project root. */
  parentId: string | null
  /** Relative folder paths, `Wohnbau Nord/03_Einreichung` style. */
  paths: readonly string[]
}

/**
 * A project folder as its reader sees it: the shelf's row, the folder's own
 * access list (ADR-0088; null when it inherits, and only ever shown to someone
 * who may read the folder), and what the reader may do there, the folder's
 * level with the project permission as the ceiling. The server checks again
 * on every write; `access` only shapes the UI.
 */
export interface ProjectFolderRow extends FolderRow {
  grants: FolderGrant[] | null
  access: 'read' | 'write'
}

const DOCUMENT_WRITE = ['project:documents:write', 'project:edit'] as const

/**
 * The reader's view of the project's folders (ADR-0087, ADR-0088): a folder they
 * may not read, and everything below it, does not exist for them.
 */
async function folderAccessFor(session: AuthorizedSession, projectId: string) {
  const project = await findProjectInOrg(projectId, session.organizationId)
  return getProjectFolderAccess(session, projectId, project?.collectionName ?? '')
}

export async function listProjectFolders(projectId: string, session: AuthorizedSession): Promise<ProjectFolderRow[]> {
  const [rows, project, tree, projectWrite] = await Promise.all([
    listShelfFolders(session, projectShelf(projectId)),
    findProjectInOrg(projectId, session.organizationId),
    listProjectFolderTree(session.organizationId, projectId),
    projectMayWriteDocuments(session, projectId),
  ])
  const access = computeFolderAccess(tree, await clearanceOf(session), project?.collectionName ?? '')
  const byId = new Map(tree.map((folder) => [folder.id, folder]))
  return rows
    .filter((row) => access.isVisible(row.id))
    .map((row) => {
      const own = byId.get(row.id)
      return {
        ...row,
        grants: own?.accessMode === 'custom' ? [...own.grants] : null,
        access: withProjectCeiling(access.levelOf(row.id), projectWrite) === 'write' ? 'write' : 'read',
      }
    })
}

/** What the session may do at the project root: write with the project's document-write permission, else read. */
export async function projectRootAccess(session: AuthorizedSession, projectId: string): Promise<'read' | 'write'> {
  return (await projectMayWriteDocuments(session, projectId)) ? 'write' : 'read'
}

export async function createProjectFolder(input: CreateFolderInput, session: AuthorizedSession) {
  // A new folder is a write into its parent (ADR-0088): the project's
  // document-write permission, and write on the parent. A parent the session
  // may not read is not found; one it may only read is refused (403).
  await requireFolderWrite(session, input.projectId, [input.parentId ?? null])
  return createShelfFolder(session, projectShelf(input.projectId), input)
}

/**
 * The root folder of this name, or null; never creates it. For a caller that
 * must decide about the destination before anything exists (the restricted-
 * folder filing check, `lib/conversations/restricted-egress.ts`). Like
 * {@link getOrCreateProjectFolderByName} it does not authorize.
 */
export function findRootProjectFolderByName(
  projectId: string,
  name: string,
  organizationId: string,
): Promise<FolderRow | null> {
  return findShelfRootFolder(projectShelf(projectId), organizationId, name)
}

/**
 * The project's root folder with this name, creating it on first use — see
 * {@link getOrCreateShelfRootFolder} for the race it is safe under.
 *
 * ## Why it takes no session
 *
 * Unlike every other function in this module it does NOT authorize. It is a
 * destination resolver for a caller that has already required
 * `project:documents:write` on this exact project, and adding a second check
 * here would say the authorization decision lives in two places. Do not call it
 * from a route. The organization is a parameter because the folder row carries
 * its tenant (migration 0102), which the caller has in hand.
 */
export function getOrCreateProjectFolderByName(
  projectId: string,
  name: string,
  organizationId: string,
): Promise<FolderRow> {
  return getOrCreateShelfRootFolder(projectShelf(projectId), organizationId, name)
}

/** A folder upload into the project: what the reader may not see is skipped, and creating needs write (ADR-0088). */
export async function ensureProjectFolderPaths(input: EnsureFolderPathsInput, session: AuthorizedSession) {
  const access = await folderAccessFor(session, input.projectId)
  const visibility: ShelfFolderVisibility = {
    isVisible: (folderId) => access.isVisible(folderId),
    assertMayCreateIn: (parentId) => {
      if (access.levelOf(parentId) !== 'write') throw folderReadOnlyError()
    },
    recheckVisible: async (folderId) => (await folderAccessFor(session, input.projectId)).isVisible(folderId),
  }
  return ensureShelfFolderPaths(session, projectShelf(input.projectId), input, visibility)
}

/**
 * The folders with their own access list at or above `folderId`, outermost
 * first; empty for the project root or a path that inherits all the way up.
 * The level on a folder is decided over exactly this list (ADR-0088: the
 * minimum over every own list on the path), so two places with the same list
 * give their contents the same access.
 */
function restrictionsAt(tree: ReadonlyMap<string, AccessFolder>, folderId: string | null): AccessFolder[] {
  const chain: AccessFolder[] = []
  const seen = new Set<string>()
  for (let current = folderId ? tree.get(folderId) : undefined; current && !seen.has(current.id); ) {
    seen.add(current.id)
    if (current.accessMode === 'custom') chain.unshift(current)
    current = current.parentId ? tree.get(current.parentId) : undefined
  }
  return chain
}

/** The audit form of {@link restrictionsAt}: each folder's `role:level` list, folders `;`-joined. */
function describeRestrictions(chain: readonly AccessFolder[]): string {
  return chain.map((folder) => describeGrants(folder.grants)).join(';')
}

async function folderTree(organizationId: string, projectId: string): Promise<Map<string, AccessFolder>> {
  return new Map((await listProjectFolderTree(organizationId, projectId)).map((entry) => [entry.id, entry]))
}

/**
 * A move or delete that changes who may read or write what is in a folder is
 * a change of folder access: it needs what `setFolderAccess` needs
 * (`project:manage`) and leaves the same audit line. Without this,
 * `project:documents:write` could widen a folder by deleting the one above it
 * that narrows it, or by moving a folder out from under one.
 */
async function recordFolderAccessChange(
  session: AuthorizedSession,
  projectId: string,
  folderId: string,
  grants: string,
  documentsMoved: number,
  request: Request | undefined,
): Promise<void> {
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.folder.access_changed',
    targetType: 'project',
    targetId: projectId,
    // `roles`, the lists' roles alone, as the first, role-only design named them.
    metadata: { folderId, grants, roles: grants.replace(/:(read|write)/g, ''), documentsMoved },
    request,
  })
}

/**
 * What a move changes about access, checked before anything is written: when
 * the old and the new parent sit under different own access lists, it needs
 * `project:manage`, is refused while the subtree holds a folder the mover
 * cannot read (moving it widens or narrows that folder blind; an organization
 * admin reads everything), and returns the lists that will govern the folder.
 * Null when the move changes no one's access. Folders not every member may
 * read hold no IFC model either (ADR-0087): a 409 when the move would put one
 * under such a folder.
 */
async function checkMove(
  session: AuthorizedSession,
  projectId: string,
  folder: { id: string; parentId: string | null },
  parentId: string | null,
): Promise<AccessFolder[] | null> {
  const tree = await folderTree(session.organizationId, projectId)
  const before = restrictionsAt(tree, folder.parentId)
  const after = restrictionsAt(tree, parentId)
  const unchanged = before.length === after.length && before.every((entry, i) => entry.id === after[i].id)
  let accessAfter: AccessFolder[] | null = null
  if (!unchanged) {
    await requireProjectAccess(session, projectId, 'project:manage')
    if (unreadableFoldersBelow(tree, await clearanceOf(session), folder.id).length > 0) {
      throw folderSubtreeUnreadableError()
    }
    // What now governs the folder itself: its new ancestors' lists, then its own.
    const own = tree.get(folder.id)
    accessAfter = [...after, ...(own && own.accessMode === 'custom' ? [own] : [])]
  }
  await assertFolderMoveKeepsIfcOpen(session.organizationId, projectId, folder.id, parentId)
  return accessAfter
}

/**
 * Rename a folder and/or move it — see {@link updateShelfFolder}. A rename or
 * move is a write on the folder (which, nesting only narrowing, is a write on
 * its parent too); a move is also a write into the new parent. One the session
 * may not read is not found, one it may only read is refused.
 */
export async function updateProjectFolder(input: UpdateFolderInput, session: AuthorizedSession, request?: Request) {
  const shelf = projectShelf(input.projectId)
  const folder = await findShelfFolder(shelf, session.organizationId, input.folderId)
  if (!folder) {
    await requireProjectAccess(session, input.projectId, [...DOCUMENT_WRITE])
    return { ok: false as const, error: 'Folder not found.' }
  }
  const moving = input.parentId !== undefined && input.parentId !== folder.parentId
  await requireFolderWrite(session, input.projectId, moving ? [folder.id, input.parentId ?? null] : [folder.id])
  const accessAfter = moving ? await checkMove(session, input.projectId, folder, input.parentId ?? null) : null

  const result = await updateShelfFolder(session, shelf, input)
  if (!result.ok || !moving || result.folder.parentId === folder.parentId) return result
  // A folder moved under (or out from under) one that restricts reading takes
  // its documents into (or out of) that folder's collection.
  const placement = await placeProjectDocuments(session.organizationId, input.projectId)
  if (accessAfter) {
    const grants = describeRestrictions(accessAfter)
    await recordFolderAccessChange(session, input.projectId, folder.id, grants, placement.moved, request)
  }
  return result
}

/**
 * Delete a folder — see {@link deleteShelfFolder}: its documents and children
 * land in its parent, and the row stays as a tombstone.
 *
 * Deleting is a write on the folder, and each child folder moves out of it: a
 * write on each child too (ADR-0088). Deleting a folder with its own list lifts
 * that list from everything it held: a change of folder access, not a tidy-up,
 * so it needs `project:manage`, is audited, and re-places the documents.
 * Deleting one that inherits changes nothing, since its children keep their
 * own lists and its documents land beside the same ancestors they had.
 */
export async function deleteProjectFolder(input: DeleteFolderInput, session: AuthorizedSession, request?: Request) {
  const shelf = projectShelf(input.projectId)
  const folder = await findShelfFolder(shelf, session.organizationId, input.folderId)
  if (!folder) {
    await requireProjectAccess(session, input.projectId, [...DOCUMENT_WRITE])
    return { ok: false as const, error: 'Folder not found.' }
  }
  const children = await getDb()
    .select({ id: projectFolders.id })
    .from(projectFolders)
    .where(
      and(
        eq(projectFolders.parentId, folder.id),
        eq(projectFolders.organizationId, session.organizationId),
        isNull(projectFolders.deletedAt),
      ),
    )
  await requireFolderWrite(session, input.projectId, [folder.id, ...children.map((child) => child.id)])
  const liftsRestriction = folder.accessMode === 'custom'
  if (liftsRestriction) await requireProjectAccess(session, input.projectId, 'project:manage')

  const outcome = await deleteShelfFolder(session, shelf, input.folderId)
  if (!outcome.ok || !liftsRestriction) return outcome
  // The documents now sit under its parent and belong in that one's collection.
  const placement = await placeProjectDocuments(session.organizationId, input.projectId)
  const tree = await folderTree(session.organizationId, input.projectId)
  const grants = describeRestrictions(restrictionsAt(tree, folder.parentId))
  await recordFolderAccessChange(session, input.projectId, folder.id, grants, placement.moved, request)
  return outcome
}

/** The path mirror onto a project's collections — see {@link mirrorShelfFolderPathRewrite}. */
export function mirrorFolderPathRewrite(
  projectId: string,
  organizationId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  return mirrorShelfFolderPathRewrite(projectShelf(projectId), organizationId, fromPath, toPath)
}
