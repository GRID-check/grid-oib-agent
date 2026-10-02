/**
 * The two reads the folder-access decision makes (ADR-0078). Kept apart from
 * the documents repository so the decision point owns its own SQL.
 */

import 'server-only'
import { and, asc, count, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, projectFolders, projects } from '@/lib/db/schema'
import { IFC_EXTENSIONS } from '@/lib/bim/types'
import type { AccessFolder } from './folder-access'

/** Whether any folder of the project is restricted. The partial index makes this one probe. */
export async function projectHasRestrictedFolders(organizationId: string, projectId: string): Promise<boolean> {
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
          isNotNull(projectFolders.restrictedRoles)
        )
      )
      .limit(1)
  )
  return rows.length > 0
}

/** The project's whole folder tree, as the decision reads it. */
export async function listProjectFolderTree(organizationId: string, projectId: string): Promise<AccessFolder[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        id: projectFolders.id,
        parentId: projectFolders.parentId,
        restrictedRoles: projectFolders.restrictedRoles,
      })
      .from(projectFolders)
      .innerJoin(projects, eq(projects.id, projectFolders.projectId))
      .where(and(eq(projectFolders.projectId, projectId), eq(projects.organizationId, organizationId)))
  )
  return rows.map((row) => ({ id: row.id, parentId: row.parentId, restrictedRoles: row.restrictedRoles ?? null }))
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
 * Projects, across every organization, that restrict at least one folder: what
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
    .selectDistinct({ organizationId: projects.organizationId, projectId: projectFolders.projectId })
    .from(projectFolders)
    .innerJoin(projects, eq(projects.id, projectFolders.projectId))
    .where(
      and(
        isNotNull(projectFolders.restrictedRoles),
        ...(page.after ? [gt(projectFolders.projectId, page.after)] : []),
        ...(page.upTo ? [lte(projectFolders.projectId, page.upTo)] : [])
      )
    )
    .orderBy(asc(projectFolders.projectId))
    .limit(page.limit)
}
