/**
 * Inbox repository — the only module that queries `inbox_items` (ADR-0035).
 *
 * Repository rules: drizzle only; no HTTP, no auth, no WorkOS; every tenant query
 * scoped by `organizationId` in SQL; every list bounded.
 *
 * The interesting part is {@link upsertInboxItem}: grouping, deduplication and
 * idempotency all come from ONE unique index on `(recipient_user_id, group_key)`
 * plus an incrementing upsert. Callers choose the behaviour by how they build the
 * group key — include an anchor (a message id) for one row per occurrence, omit it
 * to collapse a stream of events into a single counted row.
 */

import 'server-only'
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  inboxItems,
  type InboxItem,
  type InboxItemType,
  type NewInboxItem,
  type ShareableResourceType,
} from '@/lib/db/schema'

/** Hard cap for an inbox page. Read-time re-authorization cost scales with this. */
export const INBOX_LIST_LIMIT = 50

/**
 * Create or fold an item into its group.
 *
 * On conflict the row is TOUCHED rather than duplicated: the count increments,
 * `updated_at` moves to now, the newest actor/anchor/payload win, and — crucially
 * — `read_at` is cleared so new activity re-surfaces a group the user had already
 * read. An item that was resolved or archived is also revived, because a NEW
 * occurrence is new information.
 */
export async function upsertInboxItem(values: NewInboxItem): Promise<InboxItem> {
  const db = getDb()
  const [row] = await db
    .insert(inboxItems)
    .values(values)
    .onConflictDoUpdate({
      target: [inboxItems.recipientUserId, inboxItems.groupKey],
      set: {
        count: sql`${inboxItems.count} + 1`,
        updatedAt: new Date(),
        actorUserId: values.actorUserId ?? null,
        anchorId: values.anchorId ?? null,
        payload: values.payload ?? {},
        readAt: null,
        resolvedAt: null,
        archivedAt: null,
        inertAt: null,
      },
    })
    .returning()
  return row
}

/**
 * Insert many items in one statement — the participant fan-out (one item per
 * recipient). Conflicts fold exactly as {@link upsertInboxItem} does.
 */
export async function upsertInboxItems(values: NewInboxItem[]): Promise<InboxItem[]> {
  if (values.length === 0) return []
  const db = getDb()
  return db
    .insert(inboxItems)
    .values(values)
    .onConflictDoUpdate({
      target: [inboxItems.recipientUserId, inboxItems.groupKey],
      set: {
        count: sql`${inboxItems.count} + 1`,
        updatedAt: new Date(),
        readAt: null,
        resolvedAt: null,
        archivedAt: null,
        inertAt: null,
      },
    })
    .returning()
}

export interface ListInboxOptions {
  /** `true` = only things needing attention; `false`/omitted = everything unarchived. */
  pendingOnly?: boolean
  limit?: number
}

/** One recipient's inbox, newest activity first. Never crosses organizations. */
export async function listInboxItems(
  organizationId: string,
  recipientUserId: string,
  options: ListInboxOptions = {},
): Promise<InboxItem[]> {
  const { pendingOnly = false, limit = INBOX_LIST_LIMIT } = options
  const db = getDb()
  const scope = and(
    eq(inboxItems.organizationId, organizationId),
    eq(inboxItems.recipientUserId, recipientUserId),
    isNull(inboxItems.archivedAt),
  )
  return db
    .select()
    .from(inboxItems)
    .where(pendingOnly ? and(scope, pendingPredicate()) : scope)
    .orderBy(desc(inboxItems.updatedAt))
    .limit(limit)
}

/**
 * "Needs attention": not inert, and either unread or an unresolved actionable
 * request. Matches `idx_inbox_items_pending` exactly — keep the two in step, or
 * the badge silently stops using its index.
 */
function pendingPredicate() {
  return and(
    isNull(inboxItems.inertAt),
    or(isNull(inboxItems.readAt), and(eq(inboxItems.actionable, true), isNull(inboxItems.resolvedAt))),
  )
}

/** The badge number. Runs on every page render, so it stays a plain indexed count. */
export async function countPendingInboxItems(
  organizationId: string,
  recipientUserId: string,
): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.recipientUserId, recipientUserId),
        isNull(inboxItems.archivedAt),
        pendingPredicate(),
      ),
    )
  // count() arrives as a string from the driver; coerce at the boundary (AGENTS.md).
  return Number(row?.count ?? 0)
}

/** Mark specific items read. Scoped to the recipient so ids cannot be poked. */
export async function markInboxItemsRead(
  organizationId: string,
  recipientUserId: string,
  itemIds: string[],
): Promise<number> {
  if (itemIds.length === 0) return 0
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.recipientUserId, recipientUserId),
        inArray(inboxItems.id, itemIds),
        isNull(inboxItems.readAt),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length
}

/** Mark everything read (the "clear all" affordance). */
export async function markAllInboxItemsRead(
  organizationId: string,
  recipientUserId: string,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.recipientUserId, recipientUserId),
        isNull(inboxItems.readAt),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length
}

export async function archiveInboxItem(
  organizationId: string,
  recipientUserId: string,
  itemId: string,
): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.recipientUserId, recipientUserId),
        eq(inboxItems.id, itemId),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length > 0
}

/**
 * Clear ambient items for a resource once the recipient has actually looked at it
 * (spec IB-9). Deliberately does NOT touch actionable items: reading a thread is
 * not answering the question someone asked in it.
 */
export async function markResourceItemsRead(
  organizationId: string,
  recipientUserId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.recipientUserId, recipientUserId),
        eq(inboxItems.resourceType, resourceType),
        eq(inboxItems.resourceId, resourceId),
        eq(inboxItems.actionable, false),
        isNull(inboxItems.readAt),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length
}

/**
 * Resolve every actionable item that pointed at a settled request (spec MN-16).
 * Driven by domain events, not by the recipient tidying up.
 */
export async function resolveInboxItemsByGroupKeys(groupKeys: string[]): Promise<number> {
  if (groupKeys.length === 0) return 0
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ resolvedAt: new Date() })
    .where(and(inArray(inboxItems.groupKey, groupKeys), isNull(inboxItems.resolvedAt)))
    .returning({ id: inboxItems.id })
  return rows.length
}

/**
 * Neutralise one person's items for a resource — called in the SAME operation
 * that revokes their access (spec IB-14). Snippets are wiped, not just hidden:
 * the payload is the copy of content they must no longer be able to read.
 */
export async function markItemsInertForSubjectRow(
  resourceType: ShareableResourceType,
  resourceId: string,
  recipientUserId: string,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ inertAt: new Date(), payload: {} })
    .where(
      and(
        eq(inboxItems.resourceType, resourceType),
        eq(inboxItems.resourceId, resourceId),
        eq(inboxItems.recipientUserId, recipientUserId),
        isNull(inboxItems.inertAt),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length
}

/**
 * Neutralise EVERY item pointing at a resource — used when the resource is
 * soft-deleted or its visibility narrows to the point of general inaccessibility.
 */
export async function markItemsInertForResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ inertAt: new Date(), payload: {} })
    .where(
      and(
        eq(inboxItems.resourceType, resourceType),
        eq(inboxItems.resourceId, resourceId),
        isNull(inboxItems.inertAt),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length
}

/** Hard-delete every item for a resource — the purge path (spec IB-15). */
export async function deleteItemsForResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .delete(inboxItems)
    .where(and(eq(inboxItems.resourceType, resourceType), eq(inboxItems.resourceId, resourceId)))
    .returning({ id: inboxItems.id })
  return rows.length
}

/**
 * Retention prune: drop items older than the cutoff (spec IB-15). Bounded per
 * call so a backlog is worked off across ticks instead of locking the table.
 */
export async function pruneInboxItemsOlderThan(cutoff: Date, limit = 1000): Promise<number> {
  const db = getDb()
  const stale = await db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(lt(inboxItems.createdAt, cutoff))
    .limit(limit)
  if (stale.length === 0) return 0
  const rows = await db
    .delete(inboxItems)
    .where(
      inArray(
        inboxItems.id,
        stale.map((row) => row.id),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length
}

/** Distinct item types present for a recipient — used by filter chips. */
export async function listInboxTypesForRecipient(
  organizationId: string,
  recipientUserId: string,
): Promise<InboxItemType[]> {
  const db = getDb()
  const rows = await db
    .selectDistinct({ type: inboxItems.type })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.recipientUserId, recipientUserId),
        isNull(inboxItems.archivedAt),
      ),
    )
  return rows.map((row) => row.type)
}
