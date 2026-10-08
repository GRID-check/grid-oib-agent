/**
 * The reads the folder-access decision makes (ADR-0087, ADR-0088). Kept apart
 * from the documents repository so the decision point owns its own SQL.
 *
 * The tree includes deleted folders' tombstones (migration 0111): content
 * derived from a deleted folder is still judged by the access it had. Every
 * other read here — names, the sweep — is of living folders only.
 */

import 'server-only'
import { and, asc, count, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, projectFolderGrants, projectFolders, projects } from '@/lib/db/schema'
import { IFC_EXTENSIONS } from '@/lib/bim/types'
import type { AccessFolder, FolderGrant } from './folder-access'

/**
 * Whether any folder of the project, living or deleted, has its own access
 * list. The partial index makes this one probe; false is the fast path, where
 * every folder is what the project's permissions make it.
 */
export async function projectHasCustomFolders(organizationId: string, projectId: string): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: projectFolders.id })
      .from(projectFolders)
      .innerJoin(projects, eq(projects.id, projectFolders.projectId))
      .where(
        and(
          eq(projectFolders.projectId, projectId),
          eq(projects.organizationId, organizationId),
          eq(projectFolders.accessMode, 'custom')
        )
      )
      .limit(1)
  )
  return rows.length > 0
}

/** Most grants one project's folders hold, read back; 20 per custom folder by the 0110 trigger. */
const PROJECT_GRANTS_LIMIT = 20_000

/** The project's whole folder tree, tombstones included, with each custom folder's grants. */
export async function listProjectFolderTree(organizationId: string, projectId: string): Promise<AccessFolder[]> {
  const db = getDb()
  const [rows, grants] = await withTenant({ organizationId }, () =>
    Promise.all([
      db
        .select({
          id: projectFolders.id,
          parentId: projectFolders.parentId,
          accessMode: projectFolders.accessMode,
          deletedAt: projectFolders.deletedAt,
        })
        .from(projectFolders)
        .innerJoin(projects, eq(projects.id, projectFolders.projectId))
        .where(and(eq(projectFolders.projectId, projectId), eq(projects.organizationId, organizationId))),
      db
        .select({
          folderId: projectFolderGrants.folderId,
          role: projectFolderGrants.roleSlug,
          level: projectFolderGrants.level,
        })
        .from(projectFolderGrants)
        .where(
          and(eq(projectFolderGrants.projectId, projectId), eq(projectFolderGrants.organizationId, organizationId))
        )
        .limit(PROJECT_GRANTS_LIMIT),
    ])
  )
  const byFolder = new Map<string, FolderGrant[]>()
  for (const grant of grants) {
    const list = byFolder.get(grant.folderId) ?? []
    list.push({ role: grant.role, level: grant.level })
    byFolder.set(grant.folderId, list)
  }
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    accessMode: row.accessMode,
    grants: row.accessMode === 'custom' ? (byFolder.get(row.id) ?? []) : [],
    deleted: row.deletedAt !== null,
  }))
}

/**
 * The project's folders with their own access list, by name, tombstones
 * included — for labelling a restriction, never for deciding one.
 */
export async function listCustomFolderNames(
  organizationId: string,
  projectId: string
): Promise<Array<{ id: string; name: string }>> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({ id: projectFolders.id, name: projectFolders.name })
      .from(projectFolders)
      .innerJoin(projects, eq(projects.id, projectFolders.projectId))
      .where(
        and(
          eq(projectFolders.projectId, projectId),
          eq(projects.organizationId, organizationId),
          eq(projectFolders.accessMode, 'custom')
        )
      )
      .limit(500)
  )
}

/**
 * Every retrieval collection the project's documents live in: its own, and one
 * per restricted folder that holds something. What a change that must reach
 * all of them (a folder-path rewrite, a purge) iterates.
 */
export async function listProjectDocumentCollections(organizationId: string, projectId: string): Promise<string[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .selectDistinct({ collectionName: documents.collectionName })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.organizationId, organizationId)))
  )
  return rows.map((row) => row.collectionName)
}

/** Where one page of `listProjectsWithRestrictedFolders` starts and ends, by project id. */
export interface RestrictedProjectsPage {
  /** Only projects whose id sorts after this one; null for the start of the id space. */
  after: string | null
  /** Only projects whose id sorts at or before this one; null for the end of the id space. */
  upTo: string | null
  limit: number
}

/**
 * How many of a project's documents filed in `folderIds` the IFC pipeline
 * claims: what `lib/projects/ifc-folder-guard.ts` checks a restriction or a
 * folder move against. Decided by file name, as the upload dispatcher decides
 * (`isIfcFilename`), so a model whose extraction failed or has not run still
 * counts: re-ingesting it would build the model.
 */
export async function countIfcDocumentsInFolders(
  organizationId: string,
  projectId: string,
  folderIds: readonly string[]
): Promise<number> {
  if (folderIds.length === 0) return 0
  const db = getDb()
  const isIfc = or(...IFC_EXTENSIONS.map((ext) => sql`lower(btrim(${documents.filename})) LIKE ${`%${ext}`}`))
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ total: count() })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
          eq(documents.scope, 'project'),
          inArray(documents.folderId, [...folderIds]),
          isIfc
        )
      )
  )
  return Number(row?.total ?? 0)
}

/**
 * Projects, across every organization, with at least one living folder that has its own access list: what
 * the placement sweep retries (`lib/projects/placement-sweep.ts`). One page in
 * project-id order, so the sweep can walk all of them a page at a time and
 * none sits forever behind the limit. Discovery only; each project is then
 * placed inside its own tenant. The partial index makes this a scan of the
 * restricted folders alone.
 */
export async function listProjectsWithRestrictedFolders(
  page: RestrictedProjectsPage
): Promise<Array<{ organizationId: string; projectId: string }>> {
  const db = getDb()
  return db
    .selectDistinct({ organizationId: projects.organizationId, projectId: projects.id })
    .from(projectFolders)
    .innerJoin(projects, eq(projects.id, projectFolders.projectId))
    .where(
      and(
        eq(projectFolders.accessMode, 'custom'),
        isNull(projectFolders.deletedAt),
        ...(page.after ? [gt(projects.id, page.after)] : []),
        ...(page.upTo ? [lte(projects.id, page.upTo)] : [])
      )
    )
    .orderBy(asc(projects.id))
    .limit(page.limit)
}
