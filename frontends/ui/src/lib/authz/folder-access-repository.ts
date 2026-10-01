/**
 * The two reads the folder-access decision makes (ADR-0078). Kept apart from
 * the documents repository so the decision point owns its own SQL.
 */

import 'server-only'
import { and, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, projectFolders, projects } from '@/lib/db/schema'
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

/**
 * Projects, across every organization, that restrict at least one folder: what
 * the placement sweep retries (`lib/projects/placement-sweep.ts`). Discovery
 * only; each project is then placed inside its own tenant. The partial index
 * makes this a scan of the restricted folders alone.
 */
export async function listProjectsWithRestrictedFolders(
  limit: number
): Promise<Array<{ organizationId: string; projectId: string }>> {
  const db = getDb()
  return db
    .selectDistinct({ organizationId: projects.organizationId, projectId: projectFolders.projectId })
    .from(projectFolders)
    .innerJoin(projects, eq(projects.id, projectFolders.projectId))
    .where(isNotNull(projectFolders.restrictedRoles))
    .limit(limit)
}
