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
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { isUuid } from '@/lib/ids'
import { emptyProjectProfile } from '@/lib/project-profile/patch-engine'
import { salvageProjectProfile } from '@/lib/project-profile/salvage'
import { withOptionalTenant, withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { deletionQueue, projectIntakes, projects, type Project } from '@/lib/db/schema'
import type { GeocodeResult } from '@/lib/geocoding/types'
import type { DbTransaction } from '@/lib/storage/repository'
import type { ProjectOutcome, ProjectStatus } from './project-status'

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
 *
 * The profile is salvaged like {@link findProjectProfile}'s, for the reason
 * given there: a never-saved project stores `{}`, and every caller of this
 * function reads `profile.facts`. A profile nothing can be salvaged from reads
 * as the empty one, so no caller has to guard it.
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
  if (!row) return null
  return { ...row, profile: salvageProjectProfile(row.profile).profile ?? emptyProjectProfile() }
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
 *
 * An id that is not a uuid is a project that cannot exist, so it answers null
 * without a query. The id comes straight from the URL: bound to the uuid
 * column, Postgres threw `invalid input syntax for type uuid` and the project
 * page rendered a 500 instead of a 404 (issues #813/#814). Route handlers map
 * that error to 404 in `apiRoute`; server components have no such net, and
 * this probe is the first query every project page makes.
 */
export async function findProjectTenancy(
  projectId: string
): Promise<Pick<Project, 'organizationId' | 'deletedAt' | 'status'> | null> {
  if (!isUuid(projectId)) return null
  const db = getDb()
  const [row] = await withPlatformAccess(
    'project tenancy probe: resolve the owning org before authorizing',
    () =>
      db
        .select({ organizationId: projects.organizationId, deletedAt: projects.deletedAt, status: projects.status })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
  )
  return row ?? null
}

/** What the vector store's copy of a project's facts is built from (`cross-project/project-facts-mirror.ts`). */
export type ProjectFactsRow = Pick<Project, 'id' | 'organizationId' | 'collectionName' | 'profile' | 'status'>

/**
 * A page of every organization's live projects, by id, for the facts sync
 * (the weekly vector reconcile): the one cross-tenant read it needs. Bounded
 * by `limit`; the caller pages with `afterId`.
 */
export async function listProjectFactsPage(afterId: string | null, limit: number): Promise<ProjectFactsRow[]> {
  const db = getDb()
  const rows = await withPlatformAccess(
    'project facts sync: copy every live project’s facts onto its vector-store points, across organizations',
    () =>
      db
        .select({
          id: projects.id,
          organizationId: projects.organizationId,
          collectionName: projects.collectionName,
          profile: projects.profile,
          status: projects.status,
        })
        .from(projects)
        .where(and(isNull(projects.deletedAt), afterId ? sql`${projects.id} > ${afterId}` : undefined))
        .orderBy(asc(projects.id))
        .limit(limit)
  )
  return rows.map((row) => ({ ...row, profile: salvageProjectProfile(row.profile).profile ?? emptyProjectProfile() }))
}

/** A move of the lifecycle, as the repository writes it (ADR-0098). */
export type ProjectStatusWrite =
  | { status: 'active' }
  | { status: 'paused'; at: Date }
  | { status: 'closed'; at: Date; closedBy: string; outcome: ProjectOutcome; endedOn: string }

/**
 * Move a project from `from` to another state, with that state's own columns:
 * when it was paused, or when, by whom and how it closed and its Abschluss.
 * Leaving a state clears its columns, except the outcome and the Abschluss,
 * which a reopen keeps as the next close's suggestions. Only a row still in
 * `from` changes, so two people moving it at once write once, and a close
 * changes nothing when the Beginn moved past its Abschluss meanwhile; null when
 * nothing changed (either race, deleted, or not in the organization).
 */
export async function setProjectStatusInOrg(
  projectId: string,
  organizationId: string,
  from: ProjectStatus,
  change: ProjectStatusWrite
): Promise<Project | null> {
  const db = getDb()
  const cleared = { pausedAt: null, closedAt: null, closedBy: null }
  const values =
    change.status === 'closed'
      ? {
          ...cleared,
          status: 'closed' as const,
          closedAt: change.at,
          closedBy: change.closedBy,
          closedOutcome: change.outcome,
          endedOn: change.endedOn,
        }
      : change.status === 'paused'
        ? { ...cleared, status: 'paused' as const, pausedAt: change.at }
        : { ...cleared, status: 'active' as const }
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(projects)
      .set(values)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt),
          eq(projects.status, from),
          // A Steckbrief save that moved the Beginn past this Abschluss since
          // the service checked it: a lost race (409), not a CHECK violation (500).
          change.status === 'closed'
            ? sql`(${projects.startedOn} IS NULL OR ${projects.startedOn} <= ${change.endedOn}::date)`
            : undefined
        )
      )
      .returning()
  )
  return row ?? null
}

export async function insertProject(values: {
  organizationId: string
  name: string
  createdBy: string
  collectionName: string
  /** The Beginn, as stored: the first of its month. A past project created closed names it up front. */
  startedOn?: string | null
}): Promise<Project> {
  const db = getDb()
  const [row] = await withTenant({ organizationId: values.organizationId }, () =>
    db.insert(projects).values(values).returning()
  )
  return row
}

/**
 * One transaction in the organization's tenant context, for a write that spans
 * tables another repository owns (the intake row of a project being created).
 */
export async function inProjectTransaction<T>(
  organizationId: string,
  work: (tx: DbTransaction) => Promise<T>
): Promise<T> {
  const db = getDb()
  return withTenant({ organizationId }, () => db.transaction(work))
}

/** A project's address as the same-address lookup compares it. */
export interface ProjectAddressRow {
  id: string
  name: string
  status: ProjectStatus
  /** `standort_adresse` on the profile, as stored. */
  address: string | null
  /** The geocoder's hit kept with an intake, as stored. */
  location: GeocodeResult | null
}

/**
 * Every project of the organization that has an address on its profile or an
 * intake location: what „An dieser Adresse gibt es schon ein Projekt" matches
 * against. Bounded by {@link PROJECT_LIST_LIMIT}, the same cap as the list.
 * The caller filters to what the person may open.
 */
export async function listProjectAddressesInOrg(organizationId: string): Promise<ProjectAddressRow[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        address: sql<string | null>`${projects.profile} #>> '{facts,standort_adresse,value}'`,
        location: projectIntakes.location,
      })
      .from(projects)
      .leftJoin(projectIntakes, eq(projectIntakes.projectId, projects.id))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt),
          sql`(${projects.profile} #>> '{facts,standort_adresse,value}' IS NOT NULL OR ${projectIntakes.location} IS NOT NULL)`
        )
      )
      .orderBy(desc(projects.createdAt))
      .limit(PROJECT_LIST_LIMIT)
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    address: typeof row.address === 'string' ? row.address : null,
    location: row.location ?? null,
  }))
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
  values: ProjectProfileState,
  /**
   * More of the same write, committed with the profile or not at all. The
   * updated row stays locked until it returns, so a concurrent writer that
   * locks the project (`lockProjectProfile`) sees this profile, never the one
   * before it.
   */
  inTransaction?: (tx: DbTransaction, saved: ProjectProfileState) => Promise<void>
): Promise<ProjectProfileState | null> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const [row] = await tx
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
      if (!row) return null
      if (inTransaction) await inTransaction(tx, row)
      return row
    })
  )
}

/**
 * A project's profile, read under a row lock that holds until `tx` ends.
 *
 * For a write that depends on the profile (binding a document to one of its
 * buildings): a profile save in flight finishes first, and the read sees what
 * it wrote. Null when the project is gone.
 */
export async function lockProjectProfile(
  tx: DbTransaction,
  projectId: string
): Promise<Project['profile'] | null> {
  const [row] = await tx
    .select({ profile: projects.profile })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1)
    .for('update')
  return row ? salvageProjectProfile(row.profile).profile : null
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

/**
 * The stored structured profile for a project, normalized. Same nullable-org
 * rules as above.
 *
 * The column is `jsonb NOT NULL DEFAULT '{}'`, so a project whose intake was
 * never saved stores `{}`, not null. Handing that out as a `ProjectProfile`
 * let `answersFromProfile` call `Object.keys(profile.facts)` on undefined:
 * binding a Bestandsplan to a building answered 500 for every first intake.
 * The salvage parse fills the empty parts and drops malformed entries, so no
 * reader has to remember to.
 */
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
  return row ? salvageProjectProfile(row.profile).profile : null
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
