/**
 * Mentions repository — the only module that queries `mention_requests` (ADR-0034).
 *
 * Repository rules: drizzle only; no HTTP, no auth, no WorkOS; tenant queries
 * scoped by `organizationId`; lists bounded.
 *
 * Remember the derivation: the thread-level "awaiting X" state is NOT stored — it
 * is `listOpenRequestsForResource(...)` being non-empty. One source of truth, so
 * the banner and the inbox cannot disagree.
 */

import 'server-only'
import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  conversations,
  mentionRequests,
  type MentionRequest,
  type MentionRequestStatus,
  type MentionResolution,
  type NewMentionRequest,
  type ShareableResourceType,
} from '@/lib/db/schema'

/** Bound on outstanding requests surfaced for one resource. */
export const OPEN_REQUEST_LIMIT = 50

/** Create requests for a message's mentioned people. */
export async function insertMentionRequests(values: NewMentionRequest[]): Promise<MentionRequest[]> {
  if (values.length === 0) return []
  const db = getDb()
  return db.insert(mentionRequests).values(values).returning()
}

/**
 * Outstanding requests on a resource — the derived hand-off state (spec MN-8).
 * Oldest first, so the banner names whoever has been waited on longest.
 */
export async function listOpenRequestsForResource(
  resourceType: ShareableResourceType,
  resourceId: string,
  limit = OPEN_REQUEST_LIMIT,
): Promise<MentionRequest[]> {
  const db = getDb()
  return db
    .select()
    .from(mentionRequests)
    .where(
      and(
        eq(mentionRequests.resourceType, resourceType),
        eq(mentionRequests.resourceId, resourceId),
        eq(mentionRequests.status, 'open'),
      ),
    )
    .orderBy(asc(mentionRequests.createdAt))
    .limit(limit)
}

/**
 * Open requests on a resource addressed to one person. Used to decide whether a
 * given contributor's message counts as "answering" (spec MN-9.1).
 */
export async function listOpenRequestsForSubject(
  resourceType: ShareableResourceType,
  resourceId: string,
  requestedOf: string,
): Promise<MentionRequest[]> {
  const db = getDb()
  return db
    .select()
    .from(mentionRequests)
    .where(
      and(
        eq(mentionRequests.resourceType, resourceType),
        eq(mentionRequests.resourceId, resourceId),
        eq(mentionRequests.requestedOf, requestedOf),
        eq(mentionRequests.status, 'open'),
      ),
    )
    .orderBy(asc(mentionRequests.createdAt))
    .limit(OPEN_REQUEST_LIMIT)
}

/**
 * The lifecycle `status` each resolution lands on.
 *
 * Exhaustive by type rather than a ternary chain, so adding a resolution is a
 * compile error here instead of silently falling through to `void` — which is
 * what a chain ending in `: 'void'` would have done to `asked_back`, voiding a
 * request the recipient actually responded to.
 */
const STATUS_FOR_RESOLUTION: Record<MentionResolution, MentionRequestStatus> = {
  answered: 'answered',
  // They responded, so the request is closed and the thread stops waiting on
  // them; `resolution` carries the fact that the response was a question back.
  asked_back: 'answered',
  released: 'released',
  void: 'void',
}

/**
 * Close a set of requests with a resolution.
 *
 * Only `open` rows are touched, so a concurrent resolution cannot be overwritten:
 * the first close wins and a late one is a no-op rather than rewriting history
 * (spec CC-15's "first answer wins", applied to requests).
 */
export async function resolveRequests(
  requestIds: string[],
  resolution: MentionResolution,
  resolvedBy: string | null,
): Promise<MentionRequest[]> {
  if (requestIds.length === 0) return []
  const db = getDb()
  const status = STATUS_FOR_RESOLUTION[resolution]
  return db
    .update(mentionRequests)
    .set({ status, resolution, resolvedBy, resolvedAt: new Date() })
    .where(and(inArray(mentionRequests.id, requestIds), eq(mentionRequests.status, 'open')))
    .returning()
}

/**
 * Void every open request against one person on one resource — called in the same
 * operation that revokes their access (spec MN-9.4, SH-13). An open request
 * against someone who can no longer read the thread is meaningless, and leaving
 * it would keep the thread waiting forever.
 */
export async function voidOpenRequestsForSubject(
  resourceType: ShareableResourceType,
  resourceId: string,
  requestedOf: string,
): Promise<MentionRequest[]> {
  const db = getDb()
  return db
    .update(mentionRequests)
    .set({ status: 'void', resolution: 'void', resolvedAt: new Date() })
    .where(
      and(
        eq(mentionRequests.resourceType, resourceType),
        eq(mentionRequests.resourceId, resourceId),
        eq(mentionRequests.requestedOf, requestedOf),
        eq(mentionRequests.status, 'open'),
      ),
    )
    .returning()
}

/** Void every open request on a resource — used when the resource itself goes away. */
export async function voidOpenRequestsForResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<MentionRequest[]> {
  const db = getDb()
  return db
    .update(mentionRequests)
    .set({ status: 'void', resolution: 'void', resolvedAt: new Date() })
    .where(
      and(
        eq(mentionRequests.resourceType, resourceType),
        eq(mentionRequests.resourceId, resourceId),
        eq(mentionRequests.status, 'open'),
      ),
    )
    .returning()
}

/**
 * "What have I asked of others?" — the asker's side of the ledger (spec IB-21),
 * and the basis for reminders (spec MN-17).
 */
export async function listOpenRequestsByAsker(
  organizationId: string,
  requestedBy: string,
  limit = OPEN_REQUEST_LIMIT,
): Promise<MentionRequest[]> {
  const db = getDb()
  return db
    .select()
    .from(mentionRequests)
    .where(
      and(
        eq(mentionRequests.organizationId, organizationId),
        eq(mentionRequests.requestedBy, requestedBy),
        eq(mentionRequests.status, 'open'),
      ),
    )
    .orderBy(asc(mentionRequests.createdAt))
    .limit(limit)
}

/** Load one request by id, for a targeted release. */
export async function findRequestById(requestId: string): Promise<MentionRequest | null> {
  const db = getDb()
  const [row] = await db.select().from(mentionRequests).where(eq(mentionRequests.id, requestId)).limit(1)
  return row ?? null
}

/**
 * Void one person's open requests across every conversation in a project — the
 * cleanup for losing PROJECT membership (spec SH-13, MN-9.4).
 *
 * Without this, removing someone from a project leaves every thread that was
 * waiting on them **waiting forever**: they can no longer read the conversation,
 * so they can never answer, and the hand-off banner has no way to clear itself.
 * Scoped to the project, because the same person may still hold legitimate open
 * requests in another one.
 */
export async function voidOpenRequestsForSubjectInProject(
  organizationId: string,
  projectId: string,
  requestedOf: string,
): Promise<MentionRequest[]> {
  const db = getDb()
  return db
    .update(mentionRequests)
    .set({ status: 'void', resolution: 'void', resolvedAt: new Date() })
    .where(
      and(
        eq(mentionRequests.organizationId, organizationId),
        eq(mentionRequests.requestedOf, requestedOf),
        eq(mentionRequests.resourceType, 'conversation'),
        eq(mentionRequests.status, 'open'),
        inArray(
          mentionRequests.resourceId,
          db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(eq(conversations.organizationId, organizationId), eq(conversations.projectId, projectId)),
            ),
        ),
      ),
    )
    .returning()
}

/**
 * Delete requests whose target conversation no longer exists (orphan sweep).
 * Same rationale as `deleteOrphanedInboxItems`: no FK is possible on a
 * polymorphic target, so a hard delete cannot cascade here.
 */
export async function deleteOrphanedMentionRequests(limit = 500): Promise<number> {
  const db = getDb()
  const orphans = await db
    .select({ id: mentionRequests.id })
    .from(mentionRequests)
    .where(
      and(
        eq(mentionRequests.resourceType, 'conversation'),
        notExists(
          db
            .select({ one: sql`1` })
            .from(conversations)
            .where(eq(conversations.id, mentionRequests.resourceId)),
        ),
      ),
    )
    .limit(limit)
  if (orphans.length === 0) return 0
  const rows = await db
    .delete(mentionRequests)
    .where(
      inArray(
        mentionRequests.id,
        orphans.map((row) => row.id),
      ),
    )
    .returning({ id: mentionRequests.id })
  return rows.length
}

/** Hard-delete requests for a resource — the purge path. */
export async function deleteRequestsForResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .delete(mentionRequests)
    .where(and(eq(mentionRequests.resourceType, resourceType), eq(mentionRequests.resourceId, resourceId)))
    .returning({ id: mentionRequests.id })
  return rows.length
}
