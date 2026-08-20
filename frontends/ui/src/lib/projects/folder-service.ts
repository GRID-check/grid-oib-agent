import { eq, and, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projectFolders } from '@/lib/db/schema'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { AuthorizedSession } from '@/lib/auth/types'
import { validateFolderName, buildFolderPath } from './folders'

export interface CreateFolderInput {
  projectId: string
  parentId?: string | null
  name: string
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
  session: AuthorizedSession,
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
  session: AuthorizedSession,
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
      .where(and(eq(projectFolders.id, input.parentId), eq(projectFolders.projectId, input.projectId)))
      .limit(1)
    if (!parent) {
      return { ok: false, error: 'Parent folder not found.' }
    }
    parentPath = parent.path
  }

  const path = buildFolderPath(parentPath, validation.name!)

  const db = getDb()
  const [inserted] = await db
    .insert(projectFolders)
    .values({
      projectId: input.projectId,
      parentId: input.parentId ?? null,
      name: validation.name!,
      path,
    })
    .returning()

  return { ok: true, folder: toFolderRow(inserted) }
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
