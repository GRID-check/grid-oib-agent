/**
 * The reads the folder-access decision makes (ADR-0086, ADR-0087). Kept apart
 * from the documents repository so the decision point owns its own SQL.
 *
 * The tree includes deleted folders (migration 0110): in the Papierkorb, and
 * purged tombstones (0114). Content derived from a deleted folder is still
 * judged by the access it had, and once it is purged by the organization's
 * „Inhalte aus gelöschten Ordnern" setting, which the tree carries on each
 * purged folder. Every other read here — names, the sweep — is of living
 * folders only.
 */

import 'server-only'
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, projectFolderGrants, projectFolders, projects } from '@/lib/db/schema'
import { IFC_EXTENSIONS } from '@/lib/bim/types'
import { getDeletedFolderContentPolicy } from '@/lib/organizations/deleted-folder-content'
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

/**
 * Whether the project has a folder that hides documents from someone: a folder
 * with its own access list (living or deleted), or one in the Papierkorb. The
 * two partial indexes make this two probes; false is the fast path, where every
 * folder is what the project's permissions make it and every document is
 * visible. A purged tombstone holds nothing and does not count.
 */
export async function projectHasCustomOrBinnedFolders(organizationId: string, projectId: string): Promise<boolean> {
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
          or(
            eq(projectFolders.accessMode, 'custom'),
            and(isNotNull(projectFolders.deletedAt), isNull(projectFolders.purgedAt))
          )
        )
      )
      .limit(1)
  )
  return rows.length > 0
}

/** Most projects {@link listProjectsWithCustomOrBinnedFolders} answers with. */
export const RESTRICTED_PROJECTS_LIMIT = 1_000

/**
 * The organization's projects for which {@link projectHasCustomOrBinnedFolders}
 * is true, at most {@link RESTRICTED_PROJECTS_LIMIT}: the projects where a
 * folder can hide something from someone. Served by the same two partial
 * indexes, so it reads the restricted and binned folders alone.
 */
export async function listProjectsWithCustomOrBinnedFolders(organizationId: string): Promise<string[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .selectDistinct({ projectId: projectFolders.projectId })
      .from(projectFolders)
      .innerJoin(projects, eq(projects.id, projectFolders.projectId))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          or(
            eq(projectFolders.accessMode, 'custom'),
            and(isNotNull(projectFolders.deletedAt), isNull(projectFolders.purgedAt))
          )
        )
      )
      .limit(RESTRICTED_PROJECTS_LIMIT)
  )
  return rows.flatMap((row) => (row.projectId ? [row.projectId] : []))
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
          purgedAt: projectFolders.purgedAt,
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
  // The setting is read only when a purged folder is in the tree: almost no
  // project has one, and the rest never pay for the read.
  const purgedContent = rows.some((row) => row.purgedAt !== null)
    ? await getDeletedFolderContentPolicy(organizationId)
    : undefined
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    accessMode: row.accessMode,
    grants: row.accessMode === 'custom' ? (byFolder.get(row.id) ?? []) : [],
    deleted: row.deletedAt !== null,
    ...(row.purgedAt !== null ? { purgedAt: new Date(row.purgedAt), purgedContent } : {}),
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
 * Why a folder that names a role is not in a living project's folder tree: its
 * project is pending deletion (`project`), or the folder is in the Papierkorb
 * (`folder`). Either can be restored with its list. `null` for a living folder.
 */
export type FolderNamingRoleDeleted = 'folder' | 'project' | null

/** One folder, living or restorable, whose own access list names a role. */
export interface FolderNamingRole {
  folderId: string
  folderName: string
  projectId: string
  projectName: string
  /** Set when the folder will not be found in the project's folder tree until a restore. */
  deleted: FolderNamingRoleDeleted
}

/** Most folders one role's deletion confirmation lists; the total is still counted. */
export const ROLE_USAGE_LIST_LIMIT = 50

/**
 * The organization's folders whose own list names `roleSlug`: what deleting
 * the role would leave without that grant. The first
 * {@link ROLE_USAGE_LIST_LIMIT} by project and folder name, and how many there
 * are in all.
 *
 * Whatever a restore can bring back counts, because it comes back with its
 * list, which would then name a role that no longer exists: a folder in the
 * Papierkorb (`deleted_at` set, `purged_at` not), and every folder of a project
 * pending deletion (`restoreProject` clears the project's `deleted_at`). Only a
 * purged tombstone is out, and a purged project's rows are gone. `deleted` says
 * which of the two a row is, because neither is in the project's folder tree.
 */
export async function listFoldersNamingRole(
  organizationId: string,
  roleSlug: string
): Promise<{ folders: FolderNamingRole[]; total: number }> {
  const db = getDb()
  const where = and(
    eq(projectFolderGrants.organizationId, organizationId),
    eq(projectFolderGrants.roleSlug, roleSlug),
    eq(projects.organizationId, organizationId),
    isNull(projectFolders.purgedAt)
  )
  const [rows, totals] = await withTenant({ organizationId }, () =>
    Promise.all([
      db
        .select({
          folderId: projectFolders.id,
          folderName: projectFolders.name,
          projectId: projects.id,
          projectName: projects.name,
          folderDeletedAt: projectFolders.deletedAt,
          projectDeletedAt: projects.deletedAt,
        })
        .from(projectFolderGrants)
        .innerJoin(projectFolders, eq(projectFolders.id, projectFolderGrants.folderId))
        .innerJoin(projects, eq(projects.id, projectFolders.projectId))
        .where(where)
        .orderBy(asc(projects.name), asc(projectFolders.name))
        .limit(ROLE_USAGE_LIST_LIMIT),
      db
        .select({ total: count() })
        .from(projectFolderGrants)
        .innerJoin(projectFolders, eq(projectFolders.id, projectFolderGrants.folderId))
        .innerJoin(projects, eq(projects.id, projectFolders.projectId))
        .where(where),
    ])
  )
  const folders = rows.map(({ folderDeletedAt, projectDeletedAt, ...folder }): FolderNamingRole => {
    const deleted: FolderNamingRoleDeleted = projectDeletedAt ? 'project' : folderDeletedAt ? 'folder' : null
    return { ...folder, deleted }
  })
  return { folders, total: Number(totals[0]?.total ?? 0) }
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
