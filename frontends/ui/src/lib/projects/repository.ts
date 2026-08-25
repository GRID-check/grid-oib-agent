/**
 * Projects repository — the only module that talks to the `projects` (and
 * project-deletion-queue) tables for the projects domain.
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no WorkOS.
 *   - Every query that serves tenant data takes `organizationId` and scopes
 *     the WHERE clause with it — tenancy is enforced in SQL, not in JS.
 *   - Every such query also RUNS in that organization's tenant context, via
 *     `withTenant`. Having the `organizationId` and not stating it was the gap:
 *     callers with no ambient context (server components, whose `enterWith`
 *     publish does not survive this Next version's render) failed closed with
 *     `MissingTenantContextError`. The scope belongs with the argument that
 *     determines it, not with each caller's memory to establish one.
 *   - List queries are always bounded (`limit`).
 */

import 'server-only'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withOptionalTenant, withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { deletionQueue, projects, type Project } from '@/lib/db/schema'

/** Hard cap for unpaginated org-wide lists. */
export const PROJECT_LIST_LIMIT = 500

export async function listProjectsInOrg(
  organizationId: string,
  {
    limit = PROJECT_LIST_LIMIT,
    order = 'newest',
  }: { limit?: number; order?: 'newest' | 'oldest' } = {}
): Promise<Project[]> {
  // The cap is the repository's guarantee, not the caller's suggestion — a
  // default a caller can pass straight through is not a bound at all.
  const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), PROJECT_LIST_LIMIT)
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), isNull(projects.deletedAt)))
      .orderBy(order === 'oldest' ? asc(projects.createdAt) : desc(projects.createdAt))
      .limit(boundedLimit)
  )
}

/**
 * Load a project by id scoped to an organization. Soft-deleted rows are
 * excluded unless `includeDeleted` (restore flows).
 */
export async function findProjectInOrg(
  projectId: string,
  organizationId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<Project | null> {
  const db = getDb()
  const conditions = [eq(projects.id, projectId), eq(projects.organizationId, organizationId)]
  if (!options.includeDeleted) conditions.push(isNull(projects.deletedAt))
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(projects)
      .where(and(...conditions))
      .limit(1)
  )
  return row ?? null
}

/**
 * Tenancy probe for authorization: id + org + deletion state only.
 *
 * Deliberately NOT filtered by organization — the caller compares the owning
 * org against the session's and decides whether a mismatch is a 404. That is
 * what makes it a genuine cross-tenant read, so it runs under
 * {@link withPlatformAccess} with a stated reason rather than `withTenant`.
 *
 * The "unscoped by design" note this replaces was about the WHERE clause, and
 * it was read as covering the tenant context too. It does not: an unfiltered
 * predicate still has to run as somebody. `requireProjectAccess` calls this on
 * every project page, so once row-level security was enforced every one of
 * those pages threw `MissingTenantContextError` (issue #344) — the same class
 * the rest of this repository was fixed for, missed because the docstring made
 * "unscoped" sound deliberate in both senses.
 *
 * Scoping it to the session's organization instead would also stop the throw,
 * but it would make the caller's `organizationId !== session.organizationId`
 * comparison unreachable — a guard that looks live and can never fire is worse
 * than the bypass, which at least names itself.
 */
export async function findProjectTenancy(
  projectId: string
): Promise<Pick<Project, 'organizationId' | 'deletedAt'> | null> {
  const db = getDb()
  const [row] = await withPlatformAccess(
    'project tenancy probe: resolve the owning org before authorizing',
    () =>
      db
        .select({ organizationId: projects.organizationId, deletedAt: projects.deletedAt })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
  )
  return row ?? null
}

export async function insertProject(values: {
  organizationId: string
  name: string
  createdBy: string
  collectionName: string
}): Promise<Project> {
  const db = getDb()
  const [row] = await withTenant({ organizationId: values.organizationId }, () =>
    db.insert(projects).values(values).returning()
  )
  return row
}

export async function setProjectWorkosResourceId(
  projectId: string,
  organizationId: string,
  workosResourceId: string
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(projects)
      .set({ workosResourceId })
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
  )
}

/**
 * Delete a project row outright, scoped to its organization.
 *
 * NOT the product's delete — that is {@link softDeleteProjectAndEnqueue}, which
 * keeps the row (and its FGA grants) through the grace period. This is the
 * compensating action for a project whose creation failed half-way, before
 * anybody could have used it.
 */
export async function deleteProjectRow(projectId: string, organizationId: string): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
  )
}

export async function renameProjectInOrg(
  projectId: string,
  organizationId: string,
  name: string
): Promise<Project | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(projects)
      .set({ name })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt)
        )
      )
      .returning()
  )
  return row ?? null
}

/**
 * Soft-delete a project and enqueue it for purge, atomically. The purger
 * hard-deletes every store after the grace period; nothing is destroyed here.
 */
export async function softDeleteProjectAndEnqueue(
  project: Pick<Project, 'id' | 'name' | 'organizationId' | 'collectionName'>,
  requestedBy: string,
  purgeAfter: Date
): Promise<void> {
  const db = getDb()
  const now = new Date()
  await withTenant({ organizationId: project.organizationId }, () =>
    db.transaction(async (tx) => {
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
  )
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
  organizationId: string
): Promise<ProjectProfileState | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select(profileColumns)
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt)
        )
      )
      .limit(1)
  )
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
  values: ProjectProfileState
): Promise<ProjectProfileState | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(projects)
      .set(values)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt),
          eq(projects.profileVersion, expectedVersion)
        )
      )
      .returning(profileColumns)
  )
  return row ?? null
}

/**
 * Persist a generated summary (and the locale it was generated in) onto
 * profile_display.summary / .summaryLocale. No-op when the project has no
 * display yet — a summary alone cannot create a display. `summaryLocale` is
 * stored inside the same jsonb blob (no column/migration) so the Project Brief
 * can detect and repair a stale-language summary after a UI locale switch.
 */
export async function setProjectProfileSummaryInOrg(
  projectId: string,
  organizationId: string,
  summary: string,
  summaryLocale?: string
): Promise<void> {
  const db = getDb()
  const scope = and(
    eq(projects.id, projectId),
    eq(projects.organizationId, organizationId),
    isNull(projects.deletedAt)
  )
  await withTenant({ organizationId }, async () => {
    const [current] = await db
      .select({ profileDisplay: projects.profileDisplay })
      .from(projects)
      .where(scope)
      .limit(1)
    if (!current?.profileDisplay) return
    await db
      .update(projects)
      .set({ profileDisplay: { ...current.profileDisplay, summary, summaryLocale } })
      .where(scope)
  })
}

/** The WorkOS FGA resource id backing a project, or null when unregistered. */
export async function findProjectWorkosResourceId(
  projectId: string,
  organizationId: string
): Promise<string | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ workosResourceId: projects.workosResourceId })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt)
        )
      )
      .limit(1)
  )
  return row?.workosResourceId ?? null
}

/**
 * Restore a soft-deleted project while its deletion-queue row is still
 * 'pending' AND unclaimed. `markFailed` returns a partially-purged row to
 * 'pending' (with claimed_at set); restoring it would resurrect a project
 * whose Chroma/SeaweedFS data was already destroyed — a hollow, corrupt restore.
 * Returns false when there is nothing safe to restore.
 */
export async function restoreProjectIfPending(
  projectId: string,
  organizationId: string
): Promise<boolean> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const [entry] = await tx
        .update(deletionQueue)
        .set({ status: 'restored' })
        .where(
          and(
            eq(deletionQueue.entityType, 'project'),
            eq(deletionQueue.entityId, projectId),
            eq(deletionQueue.organizationId, organizationId),
            eq(deletionQueue.status, 'pending'),
            isNull(deletionQueue.claimedAt)
          )
        )
        .returning()

      if (!entry) return false

      await tx
        .update(projects)
        .set({ deletedAt: null })
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
      return true
    })
  )
}

/**
 * The stored prompt view for a project, for the agent's request context.
 *
 * `organizationId` is nullable because an anonymous single-tenant deployment
 * (REQUIRE_AUTH=false) has no session to derive one from — that is what
 * `withOptionalTenant` is for. When it IS present the predicate carries it too,
 * so a wrong-organization id returns nothing whether or not row-level security
 * is in the path.
 */
export async function findProjectPromptView(
  projectId: string,
  organizationId: string | null | undefined
): Promise<string | null> {
  const db = getDb()
  const conditions = [eq(projects.id, projectId)]
  if (organizationId) conditions.push(eq(projects.organizationId, organizationId))
  const [row] = await withOptionalTenant(
    organizationId,
    'anonymous deployment: project prompt view requested without a session',
    () =>
      db
        .select({ profilePromptView: projects.profilePromptView })
        .from(projects)
        .where(and(...conditions))
        .limit(1)
  )
  return row?.profilePromptView ?? null
}

/** The stored structured profile for a project. Same nullable-org rules as above. */
export async function findProjectProfile(
  projectId: string,
  organizationId: string | null | undefined
): Promise<Project['profile'] | null> {
  const db = getDb()
  const conditions = [eq(projects.id, projectId)]
  if (organizationId) conditions.push(eq(projects.organizationId, organizationId))
  const [row] = await withOptionalTenant(
    organizationId,
    'anonymous deployment: project jurisdiction requested without a session',
    () =>
      db
        .select({ profile: projects.profile })
        .from(projects)
        .where(and(...conditions))
        .limit(1)
  )
  return row?.profile ?? null
}

/** A project's Qdrant/Chroma collection name, scoped to its organization. */
export async function findProjectCollectionName(
  projectId: string,
  organizationId: string
): Promise<string | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ collectionName: projects.collectionName })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
      .limit(1)
  )
  return row?.collectionName ?? null
}

/** The project owning `collectionName` inside `organizationId`, or null. */
export async function findProjectIdByCollectionName(
  collectionName: string,
  organizationId: string
): Promise<string | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.collectionName, collectionName),
          eq(projects.organizationId, organizationId)
        )
      )
      .limit(1)
  )
  return row?.id ?? null
}
