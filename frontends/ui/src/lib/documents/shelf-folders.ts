/**
 * Folders of a shelf — the ONE implementation behind a project's Dateien and
 * the org-wide Archiv (ADR-0049, ADR-0078).
 *
 * Every function here takes the {@link DocumentShelf} and authorizes through
 * `requireShelfRead` / `requireShelfWrite` — the one place the two shelves'
 * permissions differ. `@/lib/projects/folder-service` and
 * `@/lib/archiv/folder-service` are only the names each shelf's callers know
 * these by. What a folder IS — its name rules,
 * its materialised path, the cycle check, the re-filing before a delete, the
 * mirror to the backend — is the same on both shelves, so it is written once.
 *
 * A shelf's rows are found by `shelfFolderWhere`, a new folder is inserted with
 * `shelfOwner`, and the database holds the rest: `project_folders`'
 * composite keys keep a parent and a document on the folder's own shelf and
 * tenant, so a bug in here cannot file across either.
 *
 * The project shelf adds per-folder access per role (ADR-0087), decided in
 * `@/lib/projects/folder-service`: it checks before calling in here and passes
 * a {@link ShelfFolderVisibility} where a walk must skip what the reader may
 * not see. A project's path rewrite reaches every collection its documents
 * live in (a restricted folder's documents are in their own). A project folder
 * is never deleted here: it goes to the Papierkorb with its contents
 * (`@/lib/projects/folder-bin`, ADR-0085), so {@link deleteShelfFolder} takes
 * the Archiv's shelf alone.
 */

import { isUniqueViolation } from '@/lib/db/errors'
import { and, eq, isNull, like, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, projectFolders } from '@/lib/db/schema'
import { getBackendUrl } from '@/lib/backend-proxy'
import { listProjectDocumentCollections } from '@/lib/authz/folder-access-repository'
import { validateFolderName, buildFolderPath, folderMatchKey, pathSegments } from '@/lib/projects/folders'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireShelfRead, requireShelfWrite } from './shelf-authz'
import { shelfCollectionName } from './shelf-collection'
import { shelfDocumentWhere, shelfOwner, shelfFolderWhere, type ArchivShelf, type DocumentShelf } from './shelf'

/** Backend calls here are decoration on a committed write — keep them short. */
const BACKEND_MIRROR_TIMEOUT_MS = 5_000

type Db = ReturnType<typeof getDb>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type FolderRecord = typeof projectFolders.$inferSelect
type Outcome<T> = ({ ok: true } & T) | { ok: false; error: string }

/**
 * A sibling already holds this exact name. Deliberately the one answer for a
 * visible sibling and a hidden one (ADR-0086): it names neither, and says no
 * more than `uniq_project_folders_parent_name` forces anyone to learn.
 */
export const FOLDER_NAME_TAKEN = 'A folder with this name already exists here.'

/**
 * What a folder walk may see and create on a shelf with per-folder access (the
 * project's, ADR-0087). Absent on the Archiv, where every folder is the shelf's.
 */
export interface ShelfFolderVisibility {
  isVisible(folderId: string): boolean
  /** Throws when the reader may not create a folder in this parent (403). */
  assertMayCreateIn(parentId: string): void
  /** Asked again after a raced insert: the winner's folder may have been restricted meanwhile. */
  recheckVisible(folderId: string): Promise<boolean>
}

export interface FolderRow {
  id: string
  /** The owning project; `null` for an Archiv folder. */
  projectId: string | null
  parentId: string | null
  name: string
  path: string
  createdAt: Date
  updatedAt: Date
}

export function toFolderRow(row: FolderRecord): FolderRow {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** What a delete moved out of the way before removing the folder. */
export interface DeleteFolderResult {
  /** Documents re-filed into the deleted folder's parent (or the root). */
  documentsMoved: number
  /** Child folders re-parented the same way. */
  foldersMoved: number
}

const folderOnShelf = (shelf: DocumentShelf, organizationId: string, folderId: string) =>
  and(eq(projectFolders.id, folderId), shelfFolderWhere(shelf, organizationId))

/** One folder of the shelf, or `undefined` — another shelf's or tenant's folder id is simply not found. */
export async function findShelfFolder(
  shelf: DocumentShelf,
  organizationId: string,
  folderId: string,
  db: Db | Tx = getDb(),
): Promise<FolderRecord | undefined> {
  const [row] = await db
    .select()
    .from(projectFolders)
    .where(folderOnShelf(shelf, organizationId, folderId))
    .limit(1)
  return row
}

export async function listShelfFolders(
  session: AuthorizedSession,
  shelf: DocumentShelf,
): Promise<FolderRow[]> {
  await requireShelfRead(session, shelf)
  const rows = await getDb()
    .select()
    .from(projectFolders)
    .where(shelfFolderWhere(shelf, session.organizationId))
    .orderBy(projectFolders.path)
  return rows.map(toFolderRow)
}

export async function createShelfFolder(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  input: { parentId?: string | null; name: string },
): Promise<Outcome<{ folder: FolderRow }>> {
  await requireShelfWrite(session, shelf)
  const organizationId = session.organizationId
  const validation = validateFolderName(input.name)
  if (!validation.ok) return { ok: false, error: validation.error! }

  let parentPath = ''
  if (input.parentId) {
    const parent = await findShelfFolder(shelf, organizationId, input.parentId)
    if (!parent) return { ok: false, error: 'Parent folder not found.' }
    parentPath = parent.path
  }

  const inserted = await insertFolderRow(getDb(), shelf, organizationId, {
    parentId: input.parentId ?? null,
    name: validation.name!,
    path: buildFolderPath(parentPath, validation.name!),
  })
  /**
   * A sibling folder already has this name.
   *
   * Before migration 0063 this insert succeeded and the shelf simply held two
   * folders with one name. The index that stops the get-or-create race below
   * also, unavoidably, applies here — so without this answer a person typing a
   * name that already exists (including anyone typing `Berichte` in a project
   * Piloti has filed into) got an opaque 500 from a raw Postgres error, for an
   * action that is neither a bug nor a race.
   *
   * The migration header says the index is there "to stop a RACE between two
   * identical writes, not to police what a human may name a folder". This is
   * what keeps that true at the surface the human touches: the same rejection
   * arrives as the validation result the caller already knows how to render.
   */
  if ('conflict' in inserted) return { ok: false, error: FOLDER_NAME_TAKEN }
  return { ok: true, folder: toFolderRow(inserted.row) }
}

/**
 * One insert. A unique violation (a sibling has the name) comes back as
 * `{ conflict }`, carrying the error so a caller that cannot recover can
 * re-throw the original; anything else throws.
 */
async function insertFolderRow(
  db: Db,
  shelf: DocumentShelf,
  organizationId: string,
  folder: { parentId: string | null; name: string; path: string },
): Promise<{ row: FolderRecord } | { conflict: unknown }> {
  try {
    const [row] = await db
      .insert(projectFolders)
      .values({ ...shelfOwner(shelf, organizationId), ...folder })
      .returning()
    return { row }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return { conflict: error }
  }
}

/** The sibling that holds `name` under `parentId` on this shelf — the winner of a race. */
async function findSibling(
  db: Db,
  shelf: DocumentShelf,
  organizationId: string,
  parentId: string | null,
  name: string,
): Promise<FolderRecord | undefined> {
  const [row] = await db
    .select()
    .from(projectFolders)
    .where(
      and(
        shelfFolderWhere(shelf, organizationId),
        parentId ? eq(projectFolders.parentId, parentId) : isNull(projectFolders.parentId),
        eq(projectFolders.name, name),
      ),
    )
    .limit(1)
  return row
}

/**
 * The shelf's root folder with this name, creating it on first use.
 *
 * ## Why it catches a unique violation instead of trusting the lookup
 *
 * Get-or-create is two statements, so two runs finishing at once both find no
 * `Berichte`, both insert one, and the shelf is left with two folders of the
 * same name and no way to say which is real. `uniq_project_folders_parent_name`
 * (0063, widened by 0102) is what makes one of those inserts fail instead of
 * succeeding.
 *
 * The index is what makes this correct; the catch is what makes it graceful. A
 * 23505 here is not an error the user caused or can act on — it is the other
 * run winning a race the caller never knew it was in — so it is answered by
 * re-selecting the winner, not by a 500 on somebody's finished report.
 */
/** The shelf's root folder of this name, or null; never creates it and does not authorize. */
export async function findShelfRootFolder(
  shelf: DocumentShelf,
  organizationId: string,
  name: string,
): Promise<FolderRow | null> {
  const row = await findSibling(getDb(), shelf, organizationId, null, name)
  return row ? toFolderRow(row) : null
}

export async function getOrCreateShelfRootFolder(
  shelf: DocumentShelf,
  organizationId: string,
  name: string,
): Promise<FolderRow> {
  const db = getDb()
  const existing = await findSibling(db, shelf, organizationId, null, name)
  if (existing) return toFolderRow(existing)

  const inserted = await insertFolderRow(db, shelf, organizationId, {
    parentId: null,
    name,
    path: buildFolderPath('', name),
  })
  if ('row' in inserted) return toFolderRow(inserted.row)
  // The concurrent writer's row, which is now the one folder that exists.
  const winner = await findSibling(db, shelf, organizationId, null, name)
  if (winner) return toFolderRow(winner)
  // Cannot happen against the real index, and returning nothing would hand the
  // caller `undefined` as a folder — so it stays the error it was.
  throw inserted.conflict

}

export interface EnsureFolderPathsInput {
  /** The level the paths are relative to. `null` is the shelf root. */
  parentId: string | null
  /** Relative folder paths, `Wohnbau Nord/03_Einreichung` style. */
  paths: readonly string[]
}

/**
 * How many folder paths one folder upload may ask for.
 *
 * A dropped tree is bounded at 2000 FILES (`dropped-entries.ts`); the number of
 * distinct directories in it is far smaller, and a request naming more than
 * this is not an Einreichung. Bounded because this endpoint inserts, and an
 * unbounded list of inserts is a request that decides how long it runs for.
 */
const MAX_ENSURE_PATHS = 300

/**
 * How deep a path may go. The same ceiling the dropped-tree walk enforces, for
 * the same reason and so the two cannot disagree about what is acceptable.
 */
const MAX_ENSURE_DEPTH = 12

/**
 * Resolve a set of folder paths to folder ids, creating what is missing.
 *
 * This is what makes a folder upload land in the shape it had on the office
 * server. The browser sends the distinct directory paths out of the dropped
 * tree; every one of them comes back as an id, whether it already existed or
 * had to be made.
 *
 * ## Matching, and why it is looser than the unique index
 *
 * A segment matches an existing sibling by {@link folderMatchKey} — case- and
 * Unicode-form-insensitive — rather than exactly. The database's uniqueness
 * rule is exact on purpose (0063: it stops a race between two identical writes,
 * it does not police what a human may name a folder), but the question HERE is
 * a different one: the reader dropped a directory called `PLAENE` and there is
 * a `Plaene` on this shelf — did they mean it? They did, every time, and
 * creating the near-duplicate would split one folder's documents across two.
 *
 * The macOS half of that matters more than the case half: a folder dragged off
 * a Mac carries decomposed umlauts, so `Pläne` from the desktop and `Pläne`
 * typed into Piloti are different strings that render identically. Exact
 * matching would have made this feature look broken for precisely the people
 * who use it.
 *
 * ## Concurrency
 *
 * Get-or-create is two statements, so two folder uploads of the same tree can
 * both miss and both insert. The unique index turns the loser into a `23505`,
 * which is answered by re-reading the winner — the same shape, and for the same
 * reason, as {@link getOrCreateShelfRootFolder}.
 *
 * Not transactional across paths, deliberately: a partial result is a set of
 * real folders the caller can file into, while a rollback on the ninetieth path
 * would discard eighty-nine folders that are correct and that a retry would
 * simply recreate.
 *
 * ## Folders the reader may not see (ADR-0086)
 *
 * With a `visibility`, a hidden folder does not exist here: it is never
 * matched, never descended into, and a hidden `parentId` is "not found".
 * Matching it would hand back its id, and creating below it would echo its
 * name in the new folder's path.
 *
 * What it cannot do is let a same-named sibling be created beside it, because
 * `uniq_project_folders_parent_name` would refuse that insert anyway. So a
 * segment whose EXACT name a hidden sibling holds is refused with
 * {@link FOLDER_NAME_TAKEN}, the answer `createShelfFolder` already gives for
 * the same collision: it names nothing and confirms no more than the index
 * forces. A segment that only matches a hidden folder loosely (`honorare` for
 * `Honorare`) is not a collision, and is created as the reader's own folder;
 * refusing it would disclose a name the index would not.
 */
export async function ensureShelfFolderPaths(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  input: EnsureFolderPathsInput,
  visibility?: ShelfFolderVisibility,
): Promise<Outcome<{ folders: FolderRow[]; folderIdByPath: Record<string, string> }>> {
  await requireShelfWrite(session, shelf)
  const organizationId = session.organizationId
  if (input.paths.length > MAX_ENSURE_PATHS) {
    return { ok: false, error: `A folder upload may create at most ${MAX_ENSURE_PATHS} folders.` }
  }
  const db = getDb()

  let root: FolderRow | null = null
  if (input.parentId) {
    if (visibility && !visibility.isVisible(input.parentId)) return { ok: false, error: 'Parent folder not found.' }
    const parent = await findShelfFolder(shelf, organizationId, input.parentId, db)
    if (!parent) return { ok: false, error: 'Parent folder not found.' }
    root = toFolderRow(parent)
  }

  // One read of the shelf's folders, then resolution happens against this
  // index. A lookup per segment would be a query per directory in the tree.
  const existing = await db.select().from(projectFolders).where(shelfFolderWhere(shelf, organizationId))
  const walk: FolderWalk = { byParentAndKey: new Map(), hiddenNames: new Set(), createdHere: new Set(), visibility }
  const index = (row: FolderRow): void => {
    walk.byParentAndKey.set(`${row.parentId ?? ''}\u0000${folderMatchKey(row.name)}`, row)
  }
  // Exact names, as the unique index compares them, of the folders this reader
  // may not see; never matched, only refused (see above).
  for (const row of existing) {
    if (!visibility || visibility.isVisible(row.id)) index(toFolderRow(row))
    else walk.hiddenNames.add(`${row.parentId ?? ''}\u0000${row.name}`)
  }

  const touched = new Map<string, FolderRow>()
  const folderIdByPath: Record<string, string> = {}

  for (const requested of input.paths) {
    const resolved = await resolvePath(db, shelf, organizationId, root, requested, walk, (created) => {
      index(created)
      touched.set(created.id, created)
    })
    if (!resolved.ok) return resolved
    if (resolved.folder) folderIdByPath[requested] = resolved.folder.id
  }

  return { ok: true, folders: [...touched.values()], folderIdByPath }
}

/** What one folder walk knows: the visible folders by match key, and the exact names it must not take. */
interface FolderWalk {
  byParentAndKey: Map<string, FolderRow>
  hiddenNames: Set<string>
  /**
   * The folders this walk inserted itself. Each inherits its parent's access,
   * which the walk asked `assertMayCreateIn` about before inserting it, so a
   * folder created inside one needs no second ask. It could not get one: the
   * reader's access was read before the folder existed, and a folder that
   * access does not know reads as `none`, which refused every nested path of a
   * folder upload into a project with any own list or a folder in the bin.
   */
  createdHere: Set<string>
  visibility: ShelfFolderVisibility | undefined
}

/** Walk one requested path from `root`, creating the segments the index does not know. */
async function resolvePath(
  db: Db,
  shelf: DocumentShelf,
  organizationId: string,
  root: FolderRow | null,
  requested: string,
  walk: FolderWalk,
  onCreated: (folder: FolderRow) => void,
): Promise<Outcome<{ folder: FolderRow | null }>> {
  const segments = pathSegments(requested)
  if (segments.length > MAX_ENSURE_DEPTH) {
    return { ok: false, error: `A folder path may be at most ${MAX_ENSURE_DEPTH} levels deep.` }
  }

  let current = root
  for (const segment of segments) {
    const validation = validateFolderName(segment)
    if (!validation.ok) return { ok: false, error: validation.error! }
    const name = validation.name!

    const match = walk.byParentAndKey.get(`${current?.id ?? ''}\u0000${folderMatchKey(name)}`)
    if (match) {
      current = match
      continue
    }
    if (walk.hiddenNames.has(`${current?.id ?? ''}\u0000${name}`)) return { ok: false, error: FOLDER_NAME_TAKEN }
    // Creating a folder is a write into its parent (ADR-0087); matching an
    // existing one is not, and the upload into it asks on its own.
    if (current && !walk.createdHere.has(current.id)) walk.visibility?.assertMayCreateIn(current.id)
    const created = await getOrCreateChild(db, shelf, organizationId, current, name)
    if (!created.ok) return created
    // A raced winner is somebody else's folder: its access is theirs to have set.
    if (!created.raced) walk.createdHere.add(created.folder.id)
    if (created.raced && walk.visibility && !(await walk.visibility.recheckVisible(created.folder.id))) {
      return { ok: false, error: FOLDER_NAME_TAKEN }
    }
    onCreated(created.folder)
    current = created.folder
  }
  // An empty path resolves to nothing — it is `root` itself, which is not in the answer.
  return { ok: true, folder: segments.length > 0 ? current : null }
}

/** One get-or-create step, with the unique-violation answer the race needs. */
async function getOrCreateChild(
  db: Db,
  shelf: DocumentShelf,
  organizationId: string,
  parent: FolderRow | null,
  name: string,
): Promise<Outcome<{ folder: FolderRow; raced: boolean }>> {
  const inserted = await insertFolderRow(db, shelf, organizationId, {
    parentId: parent?.id ?? null,
    name,
    path: buildFolderPath(parent?.path ?? '', name),
  })
  if ('row' in inserted) return { ok: true, folder: toFolderRow(inserted.row), raced: false }
  // The other run won. Its row is the one folder that exists, so this one files
  // into it rather than failing an upload nobody did anything wrong in.
  const winner = await findSibling(db, shelf, organizationId, parent?.id ?? null, name)
  if (winner) return { ok: true, folder: toFolderRow(winner), raced: true }
  return { ok: false, error: FOLDER_NAME_TAKEN }
}

/**
 * A folder's descendants, by path prefix.
 *
 * `path` is materialised on every row (`Plans/Fire Safety/Escape routes`), so a
 * rename or a move has to rewrite every row underneath the one that changed.
 * The prefix query is what finds them; `escapeLikePattern` keeps a folder
 * called `100 % Plans` from matching half the shelf.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}

/**
 * Rewrite `path` for a subtree that has just moved or been renamed.
 *
 * Done as one statement per subtree rather than a walk: the descendants all
 * share the old prefix by construction, so replacing that prefix is the whole
 * operation, and doing it in SQL keeps it inside the caller's transaction.
 */
async function rewriteDescendantPaths(
  tx: Tx,
  shelf: DocumentShelf,
  organizationId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  if (oldPath === newPath) return
  await tx
    .update(projectFolders)
    .set({
      // `char_length`, not a number bound from JS: a bound parameter reaches
      // Postgres typed `text`, and `substring(text FROM text)` is the REGEX form —
      // it returns NULL for a non-match, so renaming any folder that had children
      // failed with a NOT NULL violation on `path`. (And `String.length` counts
      // UTF-16 units where Postgres counts characters, which an emoji in a folder
      // name would have shifted.)
      path: sql`${newPath} || substring(${projectFolders.path} from char_length(${oldPath}::text) + 1)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        shelfFolderWhere(shelf, organizationId),
        like(projectFolders.path, `${escapeLikePattern(oldPath)}/%`),
      ),
    )
}

/**
 * Mirror a committed path change onto the backend's document metadata.
 *
 * The Python side files each document under the MATERIALISED PATH, not the
 * folder id (ADR-0049) — it has no `project_folders` table to join against, the
 * path is what a person reads, and a prefix match over it is the whole subtree.
 * The cost of that choice is exactly this function: a path MOVES, so every
 * rename, re-parent and delete has to be replayed on the other side or the
 * agent keeps describing a folder structure the user no longer has.
 *
 * One call, not one per document: `from_path` matches the folder itself and
 * everything filed beneath `from_path/`, which is the same prefix
 * {@link rewriteDescendantPaths} rewrites here. An empty `toPath` re-files the
 * subtree at the shelf root — what a delete does to a folder's children.
 *
 * BEST-EFFORT, with the same ordering argument as the display-title mirror in
 * `@/lib/documents/service`: the durable truth is the rows this function is
 * called after, and a backend that is down must not fail a folder rename the
 * user is entitled to. The bounded consequence is that the agent's inventory
 * and its `knowledge_search folder=` filter keep the old path until the next
 * rewrite or re-ingest — visible, and self-healing on the next move.
 */
export async function mirrorShelfFolderPathRewrite(
  shelf: DocumentShelf,
  organizationId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  if (fromPath === toPath) return
  try {
    const collectionName = await shelfCollectionName(shelf, organizationId)
    if (!collectionName) return
    // Every collection the project's documents live in, not only its own: a
    // restricted folder's documents are in theirs (ADR-0086), and a rename
    // above it must reach them too. A failed read still mirrors the shelf's
    // own collection rather than none.
    const others =
      shelf.kind === 'project'
        ? await listProjectDocumentCollections(organizationId, shelf.projectId).catch(() => [])
        : []
    const collections = new Set([collectionName, ...others])
    await Promise.all(
      [...collections].map((collection) =>
        fetch(`${getBackendUrl()}/v1/collections/${encodeURIComponent(collection)}/folder-paths`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from_path: fromPath, to_path: toPath || null }),
          signal: AbortSignal.timeout(BACKEND_MIRROR_TIMEOUT_MS),
        }).catch(() => undefined),
      ),
    )
  } catch {
    // ignore — see the note above; the folder rows are the durable truth.
  }
}

/** The new parent a rename/move resolves to: its id and its path (`''` at the root). */
async function resolveNewParent(
  db: Db,
  shelf: DocumentShelf,
  organizationId: string,
  folder: FolderRecord,
  requestedParentId: string | null | undefined,
): Promise<Outcome<{ parentId: string | null; parentPath: string }>> {
  const parentId = requestedParentId === undefined ? folder.parentId : requestedParentId
  if (!parentId) return { ok: true, parentId: null, parentPath: '' }
  if (parentId === folder.id) return { ok: false, error: 'A folder cannot be moved into itself.' }

  const parent = await findShelfFolder(shelf, organizationId, parentId, db)
  // The parent of an UNMOVED folder that has gone missing is tolerated (the
  // path falls back to the root); a requested parent that does not exist is not.
  if (!parent) {
    return requestedParentId === undefined
      ? { ok: true, parentId, parentPath: '' }
      : { ok: false, error: 'Parent folder not found.' }
  }
  if (requestedParentId !== undefined && (parent.path === folder.path || parent.path.startsWith(`${folder.path}/`))) {
    return { ok: false, error: 'A folder cannot be moved into its own subfolder.' }
  }
  return { ok: true, parentId, parentPath: parent.path }
}

/**
 * Rename a folder and/or move it to another parent.
 *
 * The cycle check is the part that cannot be skipped: moving a folder into its
 * own descendant would make a loop that no query on this table terminates on —
 * and because `path` is materialised, the loop would be invisible until
 * something walked it. A folder's own subtree is exactly the rows whose path
 * starts with its path, which is the same prefix the rewrite below uses.
 */
export async function updateShelfFolder(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  input: { folderId: string; name?: string; parentId?: string | null },
): Promise<Outcome<{ folder: FolderRow }>> {
  await requireShelfWrite(session, shelf)
  const organizationId = session.organizationId
  const db = getDb()
  const folder = await findShelfFolder(shelf, organizationId, input.folderId, db)
  if (!folder) return { ok: false, error: 'Folder not found.' }

  let name = folder.name
  if (input.name !== undefined) {
    const validation = validateFolderName(input.name)
    if (!validation.ok) return { ok: false, error: validation.error! }
    name = validation.name!
  }

  const target = await resolveNewParent(db, shelf, organizationId, folder, input.parentId)
  if (!target.ok) return target

  const path = buildFolderPath(target.parentPath, name)
  if (path === folder.path && target.parentId === folder.parentId) {
    return { ok: true, folder: toFolderRow(folder) }
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(projectFolders)
      .set({ name, parentId: target.parentId, path, updatedAt: new Date() })
      .where(folderOnShelf(shelf, organizationId, folder.id))
      .returning()
    await rewriteDescendantPaths(tx, shelf, organizationId, folder.path, path)
    return row
  })

  await mirrorShelfFolderPathRewrite(shelf, organizationId, folder.path, path)

  return { ok: true, folder: toFolderRow(updated) }
}

/**
 * Delete a folder — WITHOUT deleting the work that was filed in it.
 *
 * `documents.folder_id` is `ON DELETE CASCADE` (see the schema): removing this
 * row would take every document in the folder with it, silently and
 * irreversibly. A folder is a label somebody put on a set of documents, and
 * deleting the label must never delete the documents — so both the documents
 * and any child folders are re-filed into this folder's own parent (the shelf
 * root when it has none) INSIDE the transaction, before the row goes. Nothing
 * is ever left for the cascade to find.
 *
 * The Archiv's delete only. Nothing derived records an Archiv folder, so its
 * row goes. A PROJECT folder is not deleted this way: re-filing its contents
 * into the parent would lift the folder's own access list from them, and what
 * was derived from it must keep being judged by the access it had. It goes to
 * the Papierkorb with its contents instead (`@/lib/projects/folder-bin`,
 * ADR-0085), and the type of `shelf` keeps a project caller from landing here.
 *
 * The counts come back so the surface can say what happened rather than leaving
 * the reader to discover where their files went.
 */
export async function deleteShelfFolder(
  session: AuthorizedSession,
  shelf: ArchivShelf,
  folderId: string,
): Promise<Outcome<{ result: DeleteFolderResult }>> {
  await requireShelfWrite(session, shelf)
  const organizationId = session.organizationId
  const db = getDb()
  const folder = await findShelfFolder(shelf, organizationId, folderId, db)
  if (!folder) return { ok: false, error: 'Folder not found.' }

  const parent = folder.parentId ? await findShelfFolder(shelf, organizationId, folder.parentId, db) : undefined
  const parentPath = parent?.path ?? ''

  const result = await db.transaction(async (tx) => {
    // The documents first: they are what the cascade would have destroyed.
    const moved = await tx
      .update(documents)
      .set({ folderId: folder.parentId, updatedAt: new Date() })
      .where(and(eq(documents.folderId, folder.id), shelfDocumentWhere(shelf, organizationId)))
      .returning({ id: documents.id })

    // Then the child folders, each carrying its own subtree's paths with it.
    const children = await tx
      .select()
      .from(projectFolders)
      .where(and(eq(projectFolders.parentId, folder.id), shelfFolderWhere(shelf, organizationId)))

    for (const child of children) {
      const childPath = buildFolderPath(parentPath, child.name)
      await tx
        .update(projectFolders)
        .set({ parentId: folder.parentId, path: childPath, updatedAt: new Date() })
        .where(eq(projectFolders.id, child.id))
      await rewriteDescendantPaths(tx, shelf, organizationId, child.path, childPath)
    }

    await tx.delete(projectFolders).where(folderOnShelf(shelf, organizationId, folder.id))

    return { documentsMoved: moved.length, foldersMoved: children.length }
  })

  // The whole subtree collapsed into this folder's parent, which is a prefix
  // rewrite from the folder's path to the parent's (empty at the shelf root) —
  // `Brandschutz/Alt` becomes `Brandschutz`, carrying `Brandschutz/Alt/EG` to
  // `Brandschutz/EG` with it, exactly as the rows above just moved.
  await mirrorShelfFolderPathRewrite(shelf, organizationId, folder.path, parentPath)

  return { ok: true, result }
}
