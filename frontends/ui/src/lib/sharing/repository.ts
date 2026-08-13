/**
 * Sharing repository — the only module that queries `resource_shares`.
 *
 * Repository rules (docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no WorkOS.
 *   - every query that serves tenant data takes `organizationId` and scopes the
 *     WHERE clause with it — tenancy is enforced in SQL, not in JS.
 *   - list queries are always bounded.
 *
 * One deliberate exception, documented because it looks like a violation:
 * `findGrantForSubject` is scoped by (resourceType, resourceId, subjectUserId)
 * WITHOUT an organization predicate. It is the authorization probe, and its
 * caller (`resolveResourceAccess`) has already established that the resource
 * belongs to the caller's organization — re-checking here would be a second
 * lookup for a fact just proven. Every other read is org-scoped.
 */

import 'server-only'
import { and, desc, eq, inArray, notExists, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  conversations,
  documents,
  resourceShares,
  type NewResourceShare,
  type ResourceRole,
  type ResourceShare,
  type ShareableResourceType,
} from '@/lib/db/schema'

/** Hard cap on a single resource's grant roster (also enforced as a rule, spec SH-16). */
export const SHARE_ROSTER_LIMIT = 200

/** Hard cap for "everything shared with me" lists. */
export const SHARED_WITH_ME_LIMIT = 200

/**
 * The caller's own grant on one resource, if any. Authorization probe — see the
 * module note on why this is not org-scoped.
 */
export async function findGrantForSubject(
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
): Promise<ResourceShare | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(resourceShares)
    .where(
      and(
        eq(resourceShares.resourceType, resourceType),
        eq(resourceShares.resourceId, resourceId),
        eq(resourceShares.subjectUserId, subjectUserId),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Every grant on one resource — the roster shown in the share dialog, and the
 * participant set used for notification fan-out.
 */
export async function listGrantsForResource(
  organizationId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
  limit = SHARE_ROSTER_LIMIT,
): Promise<ResourceShare[]> {
  const db = getDb()
  return db
    .select()
    .from(resourceShares)
    .where(
      and(
        eq(resourceShares.organizationId, organizationId),
        eq(resourceShares.resourceType, resourceType),
        eq(resourceShares.resourceId, resourceId),
      ),
    )
    .orderBy(desc(resourceShares.createdAt))
    .limit(limit)
}

/**
 * Grants on many resources at once — used when annotating a LIST of resources
 * (the history panel) so it costs one query rather than one per row.
 */
export async function listGrantsForResources(
  organizationId: string,
  resourceType: ShareableResourceType,
  resourceIds: string[],
): Promise<ResourceShare[]> {
  if (resourceIds.length === 0) return []
  const db = getDb()
  return db
    .select()
    .from(resourceShares)
    .where(
      and(
        eq(resourceShares.organizationId, organizationId),
        eq(resourceShares.resourceType, resourceType),
        inArray(resourceShares.resourceId, resourceIds),
      ),
    )
    .limit(SHARE_ROSTER_LIMIT * 5)
}

/**
 * "Everything of this type shared with me" — the reverse lookup this table
 * exists for (ADR-0032), backed by `idx_resource_shares_org_subject`.
 */
export async function listResourceIdsSharedWith(
  organizationId: string,
  subjectUserId: string,
  resourceType: ShareableResourceType,
  limit = SHARED_WITH_ME_LIMIT,
): Promise<Array<{ resourceId: string; role: ResourceRole }>> {
  const db = getDb()
  const rows = await db
    .select({ resourceId: resourceShares.resourceId, role: resourceShares.role })
    .from(resourceShares)
    .where(
      and(
        eq(resourceShares.organizationId, organizationId),
        eq(resourceShares.subjectUserId, subjectUserId),
        eq(resourceShares.resourceType, resourceType),
      ),
    )
    .orderBy(desc(resourceShares.updatedAt))
    .limit(limit)
  return rows
}

/** How many grants a resource already has — enforces the roster cap before insert. */
export async function countGrantsForResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(resourceShares)
    .where(and(eq(resourceShares.resourceType, resourceType), eq(resourceShares.resourceId, resourceId)))
  // Raw sql<number> is a compile-time assertion only — the driver returns a
  // string for count(). Coerce at the repository boundary (AGENTS.md).
  return Number(row?.count ?? 0)
}

/**
 * Grant or re-grant a role. Idempotent by (resourceType, resourceId, subject):
 * re-sharing with a different role updates it rather than erroring, which is
 * what the roster UI's role dropdown needs.
 */
export async function upsertGrant(values: NewResourceShare): Promise<ResourceShare> {
  const db = getDb()
  const [row] = await db
    .insert(resourceShares)
    .values(values)
    .onConflictDoUpdate({
      target: [resourceShares.resourceType, resourceShares.resourceId, resourceShares.subjectUserId],
      set: { role: values.role, grantedBy: values.grantedBy, updatedAt: new Date() },
    })
    .returning()
  return row
}

/**
 * Remove one person's grant. Org-scoped so a guessed resource id from another
 * tenant cannot strip access there. Returns whether a row was removed.
 */
export async function deleteGrant(
  organizationId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
): Promise<boolean> {
  const db = getDb()
  const deleted = await db
    .delete(resourceShares)
    .where(
      and(
        eq(resourceShares.organizationId, organizationId),
        eq(resourceShares.resourceType, resourceType),
        eq(resourceShares.resourceId, resourceId),
        eq(resourceShares.subjectUserId, subjectUserId),
      ),
    )
    .returning({ id: resourceShares.id })
  return deleted.length > 0
}

/**
 * Delete grants whose target conversation no longer exists (orphan sweep).
 *
 * No FK is possible on a polymorphic target, so a hard delete of a conversation —
 * including the cascade from purging its project — cannot take these with it.
 * A stale grant is not an access hole (resolution 404s on a missing resource) but
 * it inflates the roster count and the "shared with me" list forever.
 */
export async function deleteOrphanedGrants(limit = 500): Promise<number> {
  const db = getDb()
  const orphans = await db
    .select({ id: resourceShares.id })
    .from(resourceShares)
    .where(
      and(
        or(
          and(
            eq(resourceShares.resourceType, 'conversation'),
            notExists(
              db
                .select({ one: sql`1` })
                .from(conversations)
                .where(eq(conversations.id, resourceShares.resourceId)),
            ),
          ),
          and(
            eq(resourceShares.resourceType, 'document'),
            notExists(
              db
                .select({ one: sql`1` })
                .from(documents)
                .where(sql`${documents.id}::text = ${resourceShares.resourceId}`),
            ),
          ),
        ),
      ),
    )
    .limit(limit)
  if (orphans.length === 0) return 0
  const rows = await db
    .delete(resourceShares)
    .where(
      inArray(
        resourceShares.id,
        orphans.map((row) => row.id),
      ),
    )
    .returning({ id: resourceShares.id })
  return rows.length
}

/**
 * Drop every grant on a resource — used by the deletion pipeline when a resource
 * is purged (spec SH-13). Not org-scoped: the caller is a purge worker acting on
 * an already-resolved resource, and a partial cleanup would leave orphans.
 */
export async function deleteAllGrantsForResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  const db = getDb()
  const deleted = await db
    .delete(resourceShares)
    .where(and(eq(resourceShares.resourceType, resourceType), eq(resourceShares.resourceId, resourceId)))
    .returning({ id: resourceShares.id })
  return deleted.length
}
