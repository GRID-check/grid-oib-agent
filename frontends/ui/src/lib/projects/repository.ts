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

/** The profile columns of a project row (the shape the profile API returns). */
export type ProjectProfileState = Pick<
  Project,
  'profile' | 'profileVersion' | 'profilePromptView' | 'profileDisplay' | 'profileUpdatedAt'
>

const profileColumns = {
  profile: projects.profile,
  profileVersion: projects.profileVersion,
  profilePromptView: projects.profilePromptView,
  profileDisplay: projects.profileDisplay,
  profileUpdatedAt: projects.profileUpdatedAt,
}

export async function findProjectProfileInOrg(
  projectId: string,
  organizationId: string,
): Promise<ProjectProfileState | null> {
  const db = getDb()
  const [row] = await db
    .select(profileColumns)
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.organizationId, organizationId), isNull(projects.deletedAt)),
    )
    .limit(1)
  return row ?? null
}

/**
 * Optimistic-concurrency profile write: applies `values` only while the
 * stored profile_version still equals `expectedVersion`. Returns null when a
 * concurrent writer bumped the version first (the service maps this to 409).
 */
export async function updateProjectProfileIfVersion(
  projectId: string,
  organizationId: string,
  expectedVersion: number,
  values: ProjectProfileState,
): Promise<ProjectProfileState | null> {
  const db = getDb()
  const [row] = await db
    .update(projects)
    .set(values)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.deletedAt),
        eq(projects.profileVersion, expectedVersion),
      ),
    )
    .returning(profileColumns)
  return row ?? null
}

/**
 * Persist a generated summary onto profile_display.summary. No-op when the
 * project has no display yet — a summary alone cannot create a display.
 */
export async function setProjectProfileSummaryInOrg(
  projectId: string,
  organizationId: string,
  summary: string,
): Promise<void> {
  const db = getDb()
  const scope = and(
    eq(projects.id, projectId),
    eq(projects.organizationId, organizationId),
    isNull(projects.deletedAt),
  )
  const [current] = await db
    .select({ profileDisplay: projects.profileDisplay })
    .from(projects)
    .where(scope)
    .limit(1)
  if (!current?.profileDisplay) return
  await db
    .update(projects)
    .set({ profileDisplay: { ...current.profileDisplay, summary } })
    .where(scope)
}

/** The WorkOS FGA resource id backing a project, or null when unregistered. */
export async function findProjectWorkosResourceId(
  projectId: string,
  organizationId: string,
): Promise<string | null> {
  const db = getDb()
  const [row] = await db
    .select({ workosResourceId: projects.workosResourceId })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.organizationId, organizationId), isNull(projects.deletedAt)),
    )
    .limit(1)
  return row?.workosResourceId ?? null
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
