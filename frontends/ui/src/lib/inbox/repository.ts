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
import { and, desc, eq, inArray, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  conversations,
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
        // These three were missing while the doc above promised the folds were
        // identical. Without them a collapsed group kept its FIRST actor and its
        // FIRST payload for good: "Anna shared a conversation with you" stayed
        // Anna's name after Bob re-shared, and the anchor kept pointing at the
        // message that opened the group rather than the one that just landed.
        // `sql` rather than a plain value because a batch insert has one `set`
        // for many rows — `excluded` is the row being inserted for THIS conflict.
        actorUserId: sql`excluded.actor_user_id`,
        anchorId: sql`excluded.anchor_id`,
        // MERGED, not replaced. The activity fan-out emits `{}` whenever the
        // title lookup comes back null (a collapsed group, a thread renamed to
        // nothing), and a straight `excluded.payload` let that one null wipe the
        // subject off every recipient's row — permanently, because the row is
        // never re-emitted with the title. `||` is jsonb concat: new keys win,
        // absent keys are left alone.
        payload: sql`${inboxItems.payload} || excluded.payload`,
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
  /**
   * Restrict to these item types. REQUIRED — see {@link InboxTypeScope}. The
   * caller decides the set from the registry's per-type gate
   * (`visibleInboxTypes`); this layer only applies it in SQL, so a type the
   * reader may not see is never fetched and then filtered in JS.
   */
  types: InboxTypeScope
}

/**
 * Type restriction as a SQL predicate.
 *
 * An EMPTY list means "no types are visible" and must match nothing —
 * `inArray(col, [])` is the one shape drizzle turns into a false predicate, but
 * relying on that implicitly is the kind of thing that changes under you, so it
 * is stated here once instead of at three call sites.
 */
/**
 * Which item types a recipient-facing query may touch.
 *
 * `EVERY_INBOX_TYPE` rather than `undefined` for the unrestricted case, and every
 * recipient-facing function below takes this REQUIRED. The gate used to be an
 * optional parameter the caller was trusted to pass, and the three reads passed
 * it while `markInboxItemsRead`, `archiveInboxItem` and the realtime badge count
 * did not — so a caller holding an item id from before collaboration was
 * switched off could still archive or read that now-hidden item, and the badge
 * counted rows the list refuses to show.
 *
 * Required means a new query cannot omit it silently: it does not compile. The
 * unrestricted value is spelled out so that using it reads as a decision, and so
 * the callers that legitimately have no reader to scope to (the emitter, the
 * cleanup jobs) are findable by searching for one identifier.
 */
export const EVERY_INBOX_TYPE = 'every-type' as const

export type InboxTypeScope = readonly InboxItemType[] | typeof EVERY_INBOX_TYPE

function typeFilter(types: InboxTypeScope | undefined) {
  if (!types || types === EVERY_INBOX_TYPE) return undefined
  // An empty set is not "no filter" — it is a reader who may see nothing, and
  // matching everything there would be the exact inversion of the gate.
  if (types.length === 0) return sql`false`
  return inArray(inboxItems.type, [...types])
}

/** One recipient's inbox, newest activity first. Never crosses organizations. */
export async function listInboxItems(
  organizationId: string,
  recipientUserId: string,
  options: ListInboxOptions,
): Promise<InboxItem[]> {
  const { pendingOnly = false, limit = INBOX_LIST_LIMIT, types } = options
  const db = getDb()
  const scope = and(
    eq(inboxItems.organizationId, organizationId),
    eq(inboxItems.recipientUserId, recipientUserId),
    isNull(inboxItems.archivedAt),
    typeFilter(types),
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
  types: InboxTypeScope,
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
        typeFilter(types),
      ),
    )
  // count() arrives as a string from the driver; coerce at the boundary (AGENTS.md).
  return Number(row?.count ?? 0)
}

/**
 * The mutation that marks a row read.
 *
 * `count` goes back to zero alongside `readAt`, because the counter means
 * "occurrences since you last read this". Leaving it standing made a group the
 * user had just read say "21 new messages" the moment a twenty-second arrived —
 * twenty of which they had already seen. The upsert increments from whatever
 * this leaves behind, so the next arrival reads "1 new message".
 */
const markReadValues = () => ({ readAt: new Date(), count: 0 })

/** Mark specific items read. Scoped to the recipient so ids cannot be poked. */
export async function markInboxItemsRead(
  organizationId: string,
  recipientUserId: string,
  itemIds: string[],
  types: InboxTypeScope,
): Promise<number> {
  if (itemIds.length === 0) return 0
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set(markReadValues())
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.recipientUserId, recipientUserId),
        inArray(inboxItems.id, itemIds),
        isNull(inboxItems.readAt),
        // Recipient scoping alone does not enforce the type gate: an id kept
        // from before collaboration was switched off still belongs to this
        // recipient, so it still matched.
        typeFilter(types),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length
}

/** Mark everything read (the "clear all" affordance), optionally per type. */
export async function markAllInboxItemsRead(
  organizationId: string,
  recipientUserId: string,
  types: InboxTypeScope,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set(markReadValues())
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.recipientUserId, recipientUserId),
        isNull(inboxItems.readAt),
        typeFilter(types),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length
}

export async function archiveInboxItem(
  organizationId: string,
  recipientUserId: string,
  itemId: string,
  types: InboxTypeScope,
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
        // See `markInboxItemsRead`: the row belongs to this recipient either
        // way, so the type gate has to be in the WHERE clause too. A miss
        // becomes the same NotFoundError as any other, which is what keeps the
        // endpoint from confirming that a hidden item exists.
        typeFilter(types),
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
    .set(markReadValues())
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
 * One item to settle, addressed the only way that is unambiguous: the group it
 * belongs to AND WHOSE it is.
 *
 * A group key is deliberately NOT unique per person — everyone mentioned on the
 * same message shares `mention.requested:conversation:<id>:<anchor>`, and the
 * unique index is on `(recipient_user_id, group_key)` precisely because the
 * recipient is half of the identity. The organization is carried too: group keys
 * are built from client-generated resource ids, so they are not tenant-unique
 * either.
 */
export interface InboxResolutionTarget {
  organizationId: string
  recipientUserId: string
  groupKey: string
}

/**
 * Resolve the actionable items that pointed at settled requests (spec MN-16).
 * Driven by domain events, not by the recipient tidying up.
 *
 * Scoped per (organization, recipient, group) pair. Matching on the group key
 * alone would resolve a COLLEAGUE's still-open request whenever one mentionee
 * answered — their badge would drop and their row would leave the "needs you"
 * page while the thread banner still said it was waiting for them, which is
 * exactly the disagreement spec MN-10 and lifecycle invariant 3 forbid.
 */
export async function resolveInboxItemsForTargets(
  targets: readonly InboxResolutionTarget[],
): Promise<number> {
  if (targets.length === 0) return 0
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        isNull(inboxItems.resolvedAt),
        or(
          ...targets.map((target) =>
            and(
              eq(inboxItems.organizationId, target.organizationId),
              eq(inboxItems.recipientUserId, target.recipientUserId),
              eq(inboxItems.groupKey, target.groupKey),
            ),
          ),
        ),
      ),
    )
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

/**
 * Neutralise one person's items across every conversation in a project — the
 * cleanup for losing PROJECT membership (spec SH-13).
 *
 * Losing container access ends effective access to every resource inside it, so
 * items pointing into that project must stop being live links. Scoped to the
 * project rather than the whole organization, because the same person may still
 * legitimately hold access in another project.
 */
export async function markItemsInertForSubjectInProject(
  organizationId: string,
  projectId: string,
  recipientUserId: string,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ inertAt: new Date(), payload: {} })
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.recipientUserId, recipientUserId),
        eq(inboxItems.resourceType, 'conversation'),
        isNull(inboxItems.inertAt),
        inArray(
          inboxItems.resourceId,
          db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(eq(conversations.organizationId, organizationId), eq(conversations.projectId, projectId)),
            ),
        ),
      ),
    )
    .returning({ id: inboxItems.id })
  return rows.length
}

/**
 * Delete items whose target conversation no longer exists — the self-healing
 * sweep for orphans.
 *
 * These rows address their target as `(resource_type, resource_id)` with no
 * foreign key (ids are heterogeneous across shareable types, and Postgres has no
 * polymorphic FK), so a hard delete of a conversation — including the cascade
 * from purging its project — cannot take them with it. Orphans are harmless for
 * access (resolution 404s on a missing resource, and the inbox re-authorizes at
 * read time) but they accumulate and leave permanently redacted rows in someone's
 * inbox, which reads as a bug. Bounded per call so a backlog is worked off across
 * ticks rather than locking a table on the render path.
 */
export async function deleteOrphanedInboxItems(limit = 500): Promise<number> {
  const db = getDb()
  const orphans = await db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.resourceType, 'conversation'),
        notExists(
          db.select({ one: sql`1` }).from(conversations).where(eq(conversations.id, inboxItems.resourceId)),
        ),
      ),
    )
    .limit(limit)
  if (orphans.length === 0) return 0
  const rows = await db
    .delete(inboxItems)
    .where(
      inArray(
        inboxItems.id,
        orphans.map((row) => row.id),
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

/**
 * Which of these (recipient, group) pairs already have a LIVE row.
 *
 * "Live" = not archived. This is the suppression probe behind fire-once-per
 * -crossing (ADR-0042): {@link upsertInboxItems} deliberately revives a row on
 * conflict — count + 1, `read_at`/`resolved_at`/`archived_at`/`inert_at` all
 * cleared — because for a mention or a new message a repeat IS new information.
 * For a standing condition it is not: re-emitting "storage is 80% full" every
 * hour would re-surface an alert the recipient had already read and dismissed,
 * every hour, until somebody freed space. The emitter therefore asks first.
 *
 * Archived rows are deliberately EXCLUDED from the answer, which is what makes a
 * re-crossing alert again: retiring the alert (archiving it) when usage falls
 * back below the threshold is what re-arms it.
 *
 * Returned as `recipientUserId\ngroupKey` keys — `\n` because a WorkOS user id
 * cannot contain one, whereas `:` appears inside every group key.
 */
export async function findLiveInboxGroupKeys(
  organizationId: string,
  targets: readonly { recipientUserId: string; groupKey: string }[],
): Promise<Set<string>> {
  if (targets.length === 0) return new Set()
  const db = getDb()
  const rows = await db
    .select({ recipientUserId: inboxItems.recipientUserId, groupKey: inboxItems.groupKey })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        isNull(inboxItems.archivedAt),
        or(
          ...targets.map((target) =>
            and(
              eq(inboxItems.recipientUserId, target.recipientUserId),
              eq(inboxItems.groupKey, target.groupKey),
            ),
          ),
        ),
      ),
    )
  return new Set(rows.map((row) => `${row.recipientUserId}\n${row.groupKey}`))
}

/**
 * Archive every live item of one type in an organization, optionally sparing one
 * anchor — the "the condition no longer holds" sweep.
 *
 * Archiving rather than deleting: the row is a real thing that was shown to
 * somebody, and retention (spec IB-15) still owns its death. Archiving takes it
 * out of the list and out of the badge, which is what "no longer true" should
 * look like, AND re-arms {@link findLiveInboxGroupKeys} so the next crossing is
 * announced instead of suppressed.
 *
 * `exceptAnchorId` is how an ESCALATION replaces rather than duplicates: when
 * usage moves from the 80% bucket to the 90% one, the 80% rows are retired in
 * the same pass that raises the 90% one, so nobody ends up with two rows about
 * one disk.
 */
export async function archiveInboxItemsOfType(
  organizationId: string,
  type: InboxItemType,
  options: { exceptAnchorId?: string } = {},
): Promise<number> {
  const db = getDb()
  const rows = await db
    .update(inboxItems)
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(inboxItems.organizationId, organizationId),
        eq(inboxItems.type, type),
        isNull(inboxItems.archivedAt),
        options.exceptAnchorId === undefined
          ? undefined
          : or(isNull(inboxItems.anchorId), ne(inboxItems.anchorId, options.exceptAnchorId)),
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
