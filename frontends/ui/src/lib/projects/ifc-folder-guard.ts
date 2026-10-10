/**
 * Folders that restrict READING do not hold IFC models (ADR-0087, ADR-0088),
 * and this is the one place that refuses it. A folder whose own list only
 * narrows who may write (every member still reads, `*`) is no restriction
 * here: its documents stay in the project's collection.
 *
 * A read-restricted folder is its own retrieval collection, which is what keeps its
 * documents out of an uncleared member's search. An IFC model is more than its
 * chunks: its building data (`bim_models`, `bim_elements`) is keyed by project,
 * not by collection, and its digest's chunks are filed under a name the
 * placement purge does not address. Until that data is partitioned, a model
 * under a restriction would be restricted in the file list and open everywhere
 * else. So the four ways a model can end up there are refused instead: an
 * upload into the folder, a document moved into it, a restriction drawn over a
 * folder that holds one, and a folder holding one moved under a restriction.
 *
 * What counts as a model is what the upload dispatcher claims
 * (`isIfcFilename`), so a model whose extraction failed or has not run yet
 * counts too: re-ingesting it would build the model.
 */

import 'server-only'
import { ConflictError } from '@/lib/api/errors'
import { computeFolderAccess, EVERY_FOLDER, type AccessFolder } from '@/lib/authz/folder-access'
import {
  countIfcDocumentsInFolders,
  listProjectFolderTree,
  projectHasCustomFolders,
} from '@/lib/authz/folder-access-repository'
import { isIfcFilename } from '@/lib/bim/types'

/** `details.code` on every refusal here, for the surfaces that explain it. */
export const IFC_IN_RESTRICTED_FOLDER = 'IFC_IN_RESTRICTED_FOLDER'

const WHY =
  'IFC models cannot be filed in a restricted folder yet: their building data is not partitioned by folder access, so everyone on the project could still query it.'

/**
 * Refuse filing an IFC model into `targetCollection` when that is a restricted
 * folder's collection rather than the project's own. For the paths that file
 * one document and already hold the decision's answer (upload, move).
 */
export function assertIfcMayBeFiledIn(filename: string, targetCollection: string, projectCollection: string): void {
  if (!isIfcFilename(filename) || targetCollection === projectCollection) return
  throw new ConflictError(WHY, { code: IFC_IN_RESTRICTED_FOLDER, models: 1 })
}

/**
 * Giving `folderId` its own access list, which every project member reads when
 * `everyoneReads` (`null` makes it inherit). Only a list that restricts reading
 * is checked: inheriting, or a list everyone reads, moves nothing out of the
 * project's collection.
 */
export async function assertRestrictionKeepsIfcOpen(
  organizationId: string,
  projectId: string,
  folderId: string,
  everyoneReads: boolean | null
): Promise<void> {
  if (everyoneReads === null || everyoneReads) return
  const tree = await listProjectFolderTree(organizationId, projectId)
  const next = tree.map((folder) =>
    folder.id === folderId ? { ...folder, accessMode: 'custom' as const, everyoneReads: false } : folder
  )
  await refuseIfcUnderRestriction(organizationId, projectId, next, folderId, (models) =>
    `This folder or its subfolders hold ${countLabel(models)}. ${WHY} Move ${models === 1 ? 'it' : 'them'} out of the folder first.`
  )
}

/** Moving `folderId` under `parentId` (`null`: the project root). */
export async function assertFolderMoveKeepsIfcOpen(
  organizationId: string,
  projectId: string,
  folderId: string,
  parentId: string | null
): Promise<void> {
  // The common case: nothing in the project is restricted, so nothing can be
  // moved under a restriction.
  if (!(await projectHasCustomFolders(organizationId, projectId))) return
  const tree = await listProjectFolderTree(organizationId, projectId)
  const next = tree.map((folder) => (folder.id === folderId ? { ...folder, parentId } : folder))
  await refuseIfcUnderRestriction(organizationId, projectId, next, folderId, (models) =>
    `This folder or its subfolders hold ${countLabel(models)}, and the destination is restricted. ${WHY}`
  )
}

function countLabel(models: number): string {
  return models === 1 ? '1 IFC model' : `${models} IFC models`
}

/**
 * Refuse when, in the folder tree `next`, any folder of `rootId`'s subtree
 * would sit under a restriction and hold an IFC model. The decision's own core
 * says which folders a restriction covers, read as placement does: whoever
 * asks, which collection does a document filed here belong in.
 */
async function refuseIfcUnderRestriction(
  organizationId: string,
  projectId: string,
  next: readonly AccessFolder[],
  rootId: string,
  message: (models: number) => string
): Promise<void> {
  const OPEN = 'open'
  const placement = computeFolderAccess(next, EVERY_FOLDER, OPEN)
  const living = next.filter((folder) => !folder.deleted)
  const covered = subtreeOf(living, rootId).filter((id) => placement.collectionFor(id) !== OPEN)
  const models = await countIfcDocumentsInFolders(organizationId, projectId, covered)
  if (models > 0) throw new ConflictError(message(models), { code: IFC_IN_RESTRICTED_FOLDER, models })
}

/** `rootId` and every folder below it in `folders`. */
export function subtreeOf(folders: readonly AccessFolder[], rootId: string): string[] {
  const children = new Map<string | null, string[]>()
  for (const folder of folders) {
    const siblings = children.get(folder.parentId) ?? []
    siblings.push(folder.id)
    children.set(folder.parentId, siblings)
  }
  const found: string[] = []
  const seen = new Set<string>()
  for (const queue = [rootId]; queue.length > 0; ) {
    const id = queue.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    found.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return found
}
