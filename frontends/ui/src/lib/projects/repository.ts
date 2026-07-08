/**
 * Projects repository — the only module that talks to the `projects` (and
 * project-deletion-queue) tables for the projects domain.
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no WorkOS.
 *   - Every query that serves tenant data takes `organizationId` and scopes
 *     the WHERE clause with it — tenancy is enforced in SQL, not in JS.
 *   - List queries are always bounded (`limit`).
 */

import 'server-only'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { deletionQueue, projects, type Project } from '@/lib/db/schema'

/** Hard cap for unpaginated org-wide lists. */
export const PROJECT_LIST_LIMIT = 500

export async function listProjectsInOrg(organizationId: string, limit = PROJECT_LIST_LIMIT): Promise<Project[]> {
  const db = getDb()
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), isNull(projects.deletedAt)))
    .orderBy(desc(projects.createdAt))
    .limit(limit)
}

/**
 * Load a project by id scoped to an organization. Soft-deleted rows are
 * excluded unless `includeDeleted` (restore flows).
 */
export async function findProjectInOrg(
  projectId: string,
  organizationId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<Project | null> {
  const db = getDb()
  const conditions = [eq(projects.id, projectId), eq(projects.organizationId, organizationId)]
  if (!options.includeDeleted) conditions.push(isNull(projects.deletedAt))
  const [row] = await db
    .select()
    .from(projects)
    .where(and(...conditions))
    .limit(1)
  return row ?? null
}

/**
 * Tenancy probe for authorization: id + org + deletion state only.
 * Unscoped by design — the caller decides whether an org mismatch is a 404.
 */
export async function findProjectTenancy(
  projectId: string,
): Promise<Pick<Project, 'organizationId' | 'deletedAt'> | null> {
  const db = getDb()
  const [row] = await db
    .select({ organizationId: projects.organizationId, deletedAt: projects.deletedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return row ?? null
}

export async function insertProject(values: {
  organizationId: string
  name: string
  createdBy: string
  collectionName: string
}): Promise<Project> {
  const db = getDb()
  const [row] = await db.insert(projects).values(values).returning()
  return row
}

export async function setProjectWorkosResourceId(projectId: string, workosResourceId: string): Promise<void> {
  const db = getDb()
  await db.update(projects).set({ workosResourceId }).where(eq(projects.id, projectId))
}

export async function renameProjectInOrg(
  projectId: string,
  organizationId: string,
  name: string,
): Promise<Project | null> {
  const db = getDb()
  const [row] = await db
    .update(projects)
    .set({ name })
    .where(
      and(eq(projects.id, projectId), eq(projects.organizationId, organizationId), isNull(projects.deletedAt)),
    )
    .returning()
  return row ?? null
}

/**
 * Soft-delete a project and enqueue it for purge, atomically. The purger
 * hard-deletes every store after the grace period; nothing is destroyed here.
 */
export async function softDeleteProjectAndEnqueue(
  project: Pick<Project, 'id' | 'name' | 'organizationId' | 'collectionName'>,
  requestedBy: string,
  purgeAfter: Date,
): Promise<void> {
  const db = getDb()
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx.update(projects).set({ deletedAt: now }).where(eq(projects.id, project.id))
    await tx
      .insert(deletionQueue)
      .values({
        entityType: 'project',
        entityId: project.id,
        displayName: project.name,
        organizationId: project.organizationId,
        requestedBy,
        purgeAfter,
        payload: { collectionName: project.collectionName },
      })
      .onConflictDoNothing()
  })
}

/**
 * Restore a soft-deleted project while its deletion-queue row is still
 * 'pending' AND unclaimed. `markFailed` returns a partially-purged row to
 * 'pending' (with claimed_at set); restoring it would resurrect a project
 * whose Chroma/MinIO data was already destroyed — a hollow, corrupt restore.
 * Returns false when there is nothing safe to restore.
 */
export async function restoreProjectIfPending(projectId: string): Promise<boolean> {
  const db = getDb()
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .update(deletionQueue)
      .set({ status: 'restored' })
      .where(
        and(
          eq(deletionQueue.entityType, 'project'),
          eq(deletionQueue.entityId, projectId),
          eq(deletionQueue.status, 'pending'),
          isNull(deletionQueue.claimedAt),
        ),
      )
      .returning()

    if (!entry) return false

    await tx.update(projects).set({ deletedAt: null }).where(eq(projects.id, projectId))
    return true
  })
}
