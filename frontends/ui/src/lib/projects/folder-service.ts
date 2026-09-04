import { eq, and, isNull, like, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, projectFolders } from '@/lib/db/schema'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getBackendUrl } from '@/lib/backend-proxy'
import { findProjectInOrg } from '@/lib/projects/repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import { validateFolderName, buildFolderPath, folderMatchKey, pathSegments } from './folders'

/** Backend calls here are decoration on a committed write — keep them short. */
const BACKEND_MIRROR_TIMEOUT_MS = 5_000

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

/** What a delete moved out of the way before removing the folder. */
export interface DeleteFolderResult {
  /** Documents re-filed into the deleted folder's parent (or the root). */
  documentsMoved: number
  /** Child folders re-parented the same way. */
  foldersMoved: number
}

export interface FolderRow {
  id: string
  projectId: string
  parentId: string | null
  name: string
  path: string
  createdAt: Date
  updatedAt: Date
}

export function toFolderRow(row: typeof projectFolders.$inferSelect): FolderRow {
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

export async function listProjectFolders(
  projectId: string,
  session: AuthorizedSession
): Promise<FolderRow[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  const db = getDb()
  const rows = await db
    .select()
    .from(projectFolders)
    .where(eq(projectFolders.projectId, projectId))
    .orderBy(projectFolders.path)
  return rows.map(toFolderRow)
}

export async function createProjectFolder(
  input: CreateFolderInput,
  session: AuthorizedSession
): Promise<{ ok: true; folder: FolderRow } | { ok: false; error: string }> {
  await requireProjectAccess(session, input.projectId, ['project:documents:write', 'project:edit'])
  const validation = validateFolderName(input.name)
  if (!validation.ok) {
    return { ok: false, error: validation.error! }
  }

  let parentPath = ''
  if (input.parentId) {
    const db = getDb()
    const [parent] = await db
      .select()
      .from(projectFolders)
      .where(
        and(eq(projectFolders.id, input.parentId), eq(projectFolders.projectId, input.projectId))
      )
      .limit(1)
    if (!parent) {
      return { ok: false, error: 'Parent folder not found.' }
    }
    parentPath = parent.path
  }

  const path = buildFolderPath(parentPath, validation.name!)

  const db = getDb()
  let inserted: FolderRow | undefined
  try {
    const [row] = await db
      .insert(projectFolders)
      .values({
        projectId: input.projectId,
        parentId: input.parentId ?? null,
        name: validation.name!,
        path,
      })
      .returning()
    inserted = toFolderRow(row)
  } catch (error) {
    /**
     * A sibling folder already has this name.
     *
     * Before migration 0063 this insert succeeded and the project simply held
     * two folders with one name. The index that stops the get-or-create race
     * below also, unavoidably, applies here — so without this catch a person
     * typing a name that already exists (including anyone typing `Berichte`
     * in a project Piloti has filed into) got an opaque 500 from a raw
     * Postgres error, for an action that is neither a bug nor a race.
     *
     * The migration header says the index is there "to stop a RACE between two
     * identical writes, not to police what a human may name a folder". This is
     * what keeps that true at the surface the human touches: the same rejection
     * arrives as the validation result the caller already knows how to render.
     */
    if ((error as { code?: string } | null)?.code !== '23505') throw error
    return { ok: false, error: 'A folder with this name already exists here.' }
  }

  return { ok: true, folder: inserted }
}

/**
 * The project's root folder with this name, creating it on first use.
 *
 * ## Why it catches a unique violation instead of trusting the lookup
 *
 * Get-or-create is two statements, so two runs finishing at once both find no
 * `Berichte`, both insert one, and the project is left with two folders of the
 * same name and no way to say which is real. Migration 0063 added
 * `uniq_project_folders_parent_name` — UNIQUE on
 * `(project_id, COALESCE(parent_id, nil uuid), name)` — which is what makes one
 * of those inserts fail instead of succeeding.
 *
 * The index is what makes this correct; the catch is what makes it graceful. A
 * 23505 here is not an error the user caused or can act on — it is the other
 * run winning a race the caller never knew it was in — so it is answered by
 * re-selecting the winner, not by a 500 on somebody's finished report.
 *
 * ## Why it takes no session
 *
 * Unlike every other function in this module it does NOT authorize. It is a
 * destination resolver for a caller that has already required
 * `project:documents:write` on this exact project, and adding a second check
 * here would say the authorization decision lives in two places. Do not call it
 * from a route.
 */
export async function getOrCreateProjectFolderByName(
  projectId: string,
  name: string,
): Promise<FolderRow> {
  const db = getDb()
  const find = async (): Promise<FolderRow | null> => {
    const [row] = await db
      .select()
      .from(projectFolders)
      .where(
        and(
          eq(projectFolders.projectId, projectId),
          isNull(projectFolders.parentId),
          eq(projectFolders.name, name),
        ),
      )
      .limit(1)
    return row ? toFolderRow(row) : null
  }

  const existing = await find()
  if (existing) return existing

  try {
    const [inserted] = await db
      .insert(projectFolders)
      .values({ projectId, parentId: null, name, path: buildFolderPath('', name) })
      .returning()
    return toFolderRow(inserted)
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== '23505') throw error
    // The concurrent writer's row, which is now the one folder that exists.
    const winner = await find()
    if (winner) return winner
    throw error
  }
}

export interface EnsureFolderPathsInput {
  projectId: string
  /** The level the paths are relative to. `null` is the project root. */
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
 * a `Plaene` in this project — did they mean it? They did, every time, and
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
 * both miss and both insert. `uniq_project_folders_parent_name` turns the loser
 * into a `23505`, which is answered by re-reading the winner — the same shape,
 * and for the same reason, as {@link getOrCreateProjectFolderByName}.
 *
 * Not transactional across paths, deliberately: a partial result is a set of
 * real folders the caller can file into, while a rollback on the ninetieth path
 * would discard eighty-nine folders that are correct and that a retry would
 * simply recreate.
 */
export async function ensureProjectFolderPaths(
  input: EnsureFolderPathsInput,
  session: AuthorizedSession,
): Promise<
  | { ok: true; folders: FolderRow[]; folderIdByPath: Record<string, string> }
  | { ok: false; error: string }
> {
  await requireProjectAccess(session, input.projectId, ['project:documents:write', 'project:edit'])
  if (input.paths.length > MAX_ENSURE_PATHS) {
    return { ok: false, error: `A folder upload may create at most ${MAX_ENSURE_PATHS} folders.` }
  }

  const db = getDb()

  let root: FolderRow | null = null
  if (input.parentId) {
    const [parent] = await db
      .select()
      .from(projectFolders)
      .where(
        and(eq(projectFolders.id, input.parentId), eq(projectFolders.projectId, input.projectId)),
      )
      .limit(1)
    if (!parent) return { ok: false, error: 'Parent folder not found.' }
    root = toFolderRow(parent)
  }

  // One read of the project's folders, then resolution happens against this
  // index. A lookup per segment would be a query per directory in the tree.
  const existing = await db
    .select()
    .from(projectFolders)
    .where(eq(projectFolders.projectId, input.projectId))
  const byParentAndKey = new Map<string, FolderRow>()
  const index = (row: FolderRow): void => {
    byParentAndKey.set(`${row.parentId ?? ''}\u0000${folderMatchKey(row.name)}`, row)
  }
  for (const row of existing) index(toFolderRow(row))

  const touched = new Map<string, FolderRow>()
  const folderIdByPath: Record<string, string> = {}

  for (const requested of input.paths) {
    const segments = pathSegments(requested)
    if (segments.length === 0) continue
    if (segments.length > MAX_ENSURE_DEPTH) {
      return { ok: false, error: `A folder path may be at most ${MAX_ENSURE_DEPTH} levels deep.` }
    }

    let current = root
    for (const segment of segments) {
      const validation = validateFolderName(segment)
      if (!validation.ok) return { ok: false, error: validation.error! }
      const name = validation.name!
      const key = `${current?.id ?? ''}\u0000${folderMatchKey(name)}`

      const match = byParentAndKey.get(key)
      if (match) {
        current = match
        continue
      }

      const created = await insertFolder(db, input.projectId, current, name)
      if (!created.ok) return created
      index(created.folder)
      touched.set(created.folder.id, created.folder)
      current = created.folder
    }

    if (current) folderIdByPath[requested] = current.id
  }

  return { ok: true, folders: [...touched.values()], folderIdByPath }
}

/** One get-or-create step, with the unique-violation answer the race needs. */
async function insertFolder(
  db: ReturnType<typeof getDb>,
  projectId: string,
  parent: FolderRow | null,
  name: string,
): Promise<{ ok: true; folder: FolderRow } | { ok: false; error: string }> {
  try {
    const [row] = await db
      .insert(projectFolders)
      .values({
        projectId,
        parentId: parent?.id ?? null,
        name,
        path: buildFolderPath(parent?.path ?? '', name),
      })
      .returning()
    return { ok: true, folder: toFolderRow(row) }
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== '23505') throw error
    // The other run won. Its row is the one folder that exists, so this one
    // files into it rather than failing an upload nobody did anything wrong in.
    const [winner] = await db
      .select()
      .from(projectFolders)
      .where(
        and(
          eq(projectFolders.projectId, projectId),
          parent ? eq(projectFolders.parentId, parent.id) : isNull(projectFolders.parentId),
          eq(projectFolders.name, name),
        ),
      )
      .limit(1)
    if (winner) return { ok: true, folder: toFolderRow(winner) }
    return { ok: false, error: 'A folder with this name already exists here.' }
  }
}

/**
 * A folder's descendants, by path prefix.
 *
 * `path` is materialised on every row (`Plans/Fire Safety/Escape routes`), so a
 * rename or a move has to rewrite every row underneath the one that changed.
 * The prefix query is what finds them; `escapeLikePattern` keeps a folder
 * called `100 % Plans` from matching half the project.
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
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  projectId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  if (oldPath === newPath) return
  await tx
    .update(projectFolders)
    .set({
      path: sql`${newPath} || substring(${projectFolders.path} from ${oldPath.length + 1})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectFolders.projectId, projectId),
        like(projectFolders.path, `${escapeLikePattern(oldPath)}/%`)
      )
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
 * subtree at the project root — what a delete does to a folder's children.
 *
 * BEST-EFFORT, with the same ordering argument as the display-title mirror in
 * `@/lib/documents/service`: the durable truth is the rows this function is
 * called after, and a backend that is down must not fail a folder rename the
 * user is entitled to. The bounded consequence is that the agent's inventory
 * and its `knowledge_search folder=` filter keep the old path until the next
 * rewrite or re-ingest — visible, and self-healing on the next move.
 */
export async function mirrorFolderPathRewrite(
  projectId: string,
  organizationId: string,
  fromPath: string,
  toPath: string
): Promise<void> {
  if (fromPath === toPath) return
  try {
    const project = await findProjectInOrg(projectId, organizationId)
    if (!project) return
    await fetch(
      `${getBackendUrl()}/v1/collections/${encodeURIComponent(project.collectionName)}/folder-paths`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_path: fromPath, to_path: toPath || null }),
        signal: AbortSignal.timeout(BACKEND_MIRROR_TIMEOUT_MS),
      }
    )
  } catch {
    // ignore — see the note above; the folder rows are the durable truth.
  }
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
export async function updateProjectFolder(
  input: UpdateFolderInput,
  session: AuthorizedSession
): Promise<{ ok: true; folder: FolderRow } | { ok: false; error: string }> {
  await requireProjectAccess(session, input.projectId, ['project:documents:write', 'project:edit'])
  const db = getDb()

  const [folder] = await db
    .select()
    .from(projectFolders)
    .where(
      and(eq(projectFolders.id, input.folderId), eq(projectFolders.projectId, input.projectId))
    )
    .limit(1)
  if (!folder) return { ok: false, error: 'Folder not found.' }

  let name = folder.name
  if (input.name !== undefined) {
    const validation = validateFolderName(input.name)
    if (!validation.ok) return { ok: false, error: validation.error! }
    name = validation.name!
  }

  let parentId = folder.parentId
  let parentPath = ''
  if (input.parentId !== undefined) {
    parentId = input.parentId
    if (parentId === folder.id) {
      return { ok: false, error: 'A folder cannot be moved into itself.' }
    }
    if (parentId) {
      const [parent] = await db
        .select()
        .from(projectFolders)
        .where(and(eq(projectFolders.id, parentId), eq(projectFolders.projectId, input.projectId)))
        .limit(1)
      if (!parent) return { ok: false, error: 'Parent folder not found.' }
      if (parent.path === folder.path || parent.path.startsWith(`${folder.path}/`)) {
        return { ok: false, error: 'A folder cannot be moved into its own subfolder.' }
      }
      parentPath = parent.path
    }
  } else if (folder.parentId) {
    const [parent] = await db
      .select()
      .from(projectFolders)
      .where(
        and(eq(projectFolders.id, folder.parentId), eq(projectFolders.projectId, input.projectId))
      )
      .limit(1)
    parentPath = parent?.path ?? ''
  }

  const path = buildFolderPath(parentPath, name)
  if (path === folder.path && parentId === folder.parentId) {
    return { ok: true, folder: toFolderRow(folder) }
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(projectFolders)
      .set({ name, parentId, path, updatedAt: new Date() })
      .where(and(eq(projectFolders.id, folder.id), eq(projectFolders.projectId, input.projectId)))
      .returning()
    await rewriteDescendantPaths(tx, input.projectId, folder.path, path)
    return row
  })

  await mirrorFolderPathRewrite(input.projectId, session.organizationId, folder.path, path)

  return { ok: true, folder: toFolderRow(updated) }
}

/**
 * Delete a folder — WITHOUT deleting the work that was filed in it.
 *
 * `documents.folder_id` is `ON DELETE CASCADE` (see the schema): removing this
 * row would take every document in the folder with it, silently and
 * irreversibly. A folder is a label somebody put on a set of documents, and
 * deleting the label must never delete the documents — so both the documents
 * and any child folders are re-filed into this folder's own parent (the project
 * root when it has none) INSIDE the transaction, before the row goes. Nothing
 * is ever left for the cascade to find.
 *
 * The counts come back so the surface can say what happened rather than leaving
 * the reader to discover where their files went.
 */
export async function deleteProjectFolder(
  input: DeleteFolderInput,
  session: AuthorizedSession
): Promise<{ ok: true; result: DeleteFolderResult } | { ok: false; error: string }> {
  await requireProjectAccess(session, input.projectId, ['project:documents:write', 'project:edit'])
  const db = getDb()

  const [folder] = await db
    .select()
    .from(projectFolders)
    .where(
      and(eq(projectFolders.id, input.folderId), eq(projectFolders.projectId, input.projectId))
    )
    .limit(1)
  if (!folder) return { ok: false, error: 'Folder not found.' }

  let parentPath = ''
  if (folder.parentId) {
    const [parent] = await db
      .select()
      .from(projectFolders)
      .where(
        and(eq(projectFolders.id, folder.parentId), eq(projectFolders.projectId, input.projectId))
      )
      .limit(1)
    parentPath = parent?.path ?? ''
  }

  const outcome = await db.transaction(async (tx) => {
    // The documents first: they are what the cascade would have destroyed.
    const moved = await tx
      .update(documents)
      .set({ folderId: folder.parentId, updatedAt: new Date() })
      .where(and(eq(documents.folderId, folder.id), eq(documents.projectId, input.projectId)))
      .returning({ id: documents.id })

    // Then the child folders, each carrying its own subtree's paths with it.
    const children = await tx
      .select()
      .from(projectFolders)
      .where(
        and(eq(projectFolders.parentId, folder.id), eq(projectFolders.projectId, input.projectId))
      )

    for (const child of children) {
      const childPath = buildFolderPath(parentPath, child.name)
      await tx
        .update(projectFolders)
        .set({ parentId: folder.parentId, path: childPath, updatedAt: new Date() })
        .where(eq(projectFolders.id, child.id))
      await rewriteDescendantPaths(tx, input.projectId, child.path, childPath)
    }

    await tx
      .delete(projectFolders)
      .where(and(eq(projectFolders.id, folder.id), eq(projectFolders.projectId, input.projectId)))

    return {
      ok: true as const,
      result: { documentsMoved: moved.length, foldersMoved: children.length },
    }
  })

  // The whole subtree collapsed into this folder's parent, which is a prefix
  // rewrite from the folder's path to the parent's (empty at the project root) —
  // `Brandschutz/Alt` becomes `Brandschutz`, carrying `Brandschutz/Alt/EG` to
  // `Brandschutz/EG` with it, exactly as the rows above just moved.
  await mirrorFolderPathRewrite(input.projectId, session.organizationId, folder.path, parentPath)

  return outcome
}
