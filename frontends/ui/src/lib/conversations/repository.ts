/**
 * Conversations repository — the only module that talks to the
 * `conversations` and `messages` tables for the conversations domain.
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no WorkOS.
 *   - Every query that serves tenant data takes `organizationId` and scopes
 *     the WHERE clause with it — tenancy is enforced in SQL, not in JS.
 *     (`messages` has no organization column; callers must resolve the
 *     conversation through an org-scoped lookup before touching messages.)
 *   - List queries are always bounded (`limit`).
 */

import 'server-only'
import { and, asc, desc, eq, exists, isNull, ne, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  conversationReads,
  conversations,
  messages,
  resourceShares,
  type Conversation,
  type ConversationRead,
  type Message,
  type NewMessage,
  type ResourceVisibility,
} from '@/lib/db/schema'

/** Hard cap for unpaginated org-wide conversation lists. */
export const CONVERSATION_LIST_LIMIT = 200

/** Hard cap for a single conversation's message history. */
export const MESSAGE_LIST_LIMIT = 1000

/**
 * "A grant on this conversation names the caller" — as a CORRELATED subquery, so
 * the whole visibility rule is one round trip (ADR-0032).
 *
 * The alternative — resolving effective access per row — would be N calls to
 * WorkOS FGA on a list render, which is exactly the cost ADR-0032 exists to
 * avoid. Kept org-scoped as well as resource-scoped: a grant row is tenant data
 * like any other.
 */
function grantNamesCaller(organizationId: string, userId: string) {
  const db = getDb()
  return exists(
    db
      .select({ one: sql`1` })
      .from(resourceShares)
      .where(
        and(
          eq(resourceShares.organizationId, organizationId),
          eq(resourceShares.resourceType, 'conversation'),
          eq(resourceShares.resourceId, conversations.id),
          eq(resourceShares.subjectUserId, userId),
        ),
      ),
  )
}

/**
 * List the conversations one caller may actually see — the visibility-aware
 * replacement for the old org-scoped list (spec SH-4, ADR-0032).
 *
 * The old query returned EVERY conversation in the organization, which is the
 * defect §3 of the collaboration spec calls out: "private chat" did not exist,
 * the project-scoped UI merely masked it. Filtering happens in SQL because the
 * alternative is one authorization round trip per row.
 *
 * Two shapes, because the caller's provable reach differs:
 *
 *   - **With `projectId`** (the normal case): the service has already proved the
 *     caller reaches that project (`requireProjectAccess`), so every
 *     `project`-visible row INSIDE IT is visible to them by definition. Only
 *     `private` rows need narrowing, to creator-or-grantee. A row with a NULL
 *     `project_id` is **not** inside that project, so the proof says nothing
 *     about it and it is judged on its own terms — exactly the terms
 *     `resolveResourceAccess` uses when there is no container to check: its
 *     creator, an explicit grantee, or `organization` visibility. Sharing the
 *     null-project clause and the visibility clause as two INDEPENDENT
 *     disjuncts is what leaked: an unstamped conversation whose owner set
 *     `project` visibility satisfied both for any caller in any project, so its
 *     id, title, tags and author were listed org-wide and then 404'd on open —
 *     the list and the access resolver disagreeing, which is the one thing this
 *     query must never do.
 *
 *   - **Without `projectId`**: there is no proven container, and we will NOT do
 *     an FGA probe per row. The unscoped list is therefore narrowed to what the
 *     caller reaches without any project claim at all: rows they created, rows
 *     granted to them, and `organization`-visible rows. This is a DELIBERATE
 *     tightening of previous behaviour (spec MG-1) — the unscoped list used to
 *     return the whole organization — and it is the safe direction: a
 *     project-visible thread is still listed by the project-scoped call the UI
 *     actually makes.
 */
export async function listVisibleConversations(
  organizationId: string,
  userId: string,
  options: { projectId?: string; limit?: number } = {},
): Promise<Conversation[]> {
  const { projectId, limit = CONVERSATION_LIST_LIMIT } = options
  const db = getDb()
  const orgScope = eq(conversations.organizationId, organizationId)
  const mine = eq(conversations.createdBy, userId)
  const granted = grantNamesCaller(organizationId, userId)

  // The grounds a row is visible on when NO container backs it — the same answer
  // `resolveResourceAccess` reaches for a null-project resource, and the same
  // rule the unscoped branch below applies.
  const withoutContainer = or(mine, granted, eq(conversations.visibility, 'organization'))

  const scope = projectId
    ? and(
        orgScope,
        or(
          // Inside the project the caller has proved they reach, only `private`
          // needs narrowing.
          and(
            eq(conversations.projectId, projectId),
            or(ne(conversations.visibility, 'private'), mine, granted),
          ),
          // Unstamped rows are judged without any project claim, so that the list
          // agrees with the access resolver instead of advertising titles it will
          // then 404 on.
          and(isNull(conversations.projectId), withoutContainer),
        ),
      )
    : and(orgScope, withoutContainer)

  return db.select().from(conversations).where(scope).orderBy(desc(conversations.updatedAt)).limit(limit)
}

/**
 * Load a conversation by id scoped to an organization.
 *
 * **Not an authorization check.** Org scope alone is what made every chat
 * readable by every colleague (ADR-0032). Session-carrying callers MUST resolve
 * access through `requireResourceAccess(session, 'conversation', …)` first; this
 * query then serves the row, and is the ONLY tenancy gate on the session-less
 * internal (service-token) path, which has no session to resolve access for.
 */
export async function findConversationInOrg(
  conversationId: string,
  organizationId: string,
): Promise<Conversation | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

/**
 * Every conversation id in a project — the cascade fan-out for project-level
 * cleanup (spec SH-13).
 *
 * Ids only: the caller is settling collaboration state per conversation and needs
 * nothing else. Bounded, like every list here; a project with more conversations
 * than the cap would leave a remainder for the orphan sweep to reconcile, which is
 * the safe direction to fail in.
 */
export async function listConversationIdsForProject(
  projectId: string,
  organizationId: string,
  limit = 5_000,
): Promise<string[]> {
  const db = getDb()
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.projectId, projectId)))
    .limit(limit)
  return rows.map((row) => row.id)
}

/**
 * Tenancy probe for authorization: the fields `@/lib/sharing` needs to decide
 * access, and nothing else.
 *
 * Unscoped by design — the caller decides whether an organization mismatch is a
 * 404. Mirrors `findProjectTenancy`; the sharing registry's `resolveContainer`
 * and `readVisibility` both go through here.
 */
export async function findConversationTenancy(
  conversationId: string,
): Promise<Pick<Conversation, 'organizationId' | 'projectId' | 'visibility' | 'createdBy' | 'deletedAt'> | null> {
  const db = getDb()
  const [row] = await db
    .select({
      organizationId: conversations.organizationId,
      projectId: conversations.projectId,
      visibility: conversations.visibility,
      createdBy: conversations.createdBy,
      deletedAt: conversations.deletedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  return row ?? null
}

/**
 * Set a conversation's blanket visibility, scoped to the organization in SQL.
 * Returns null when the row does not exist in this org (caller maps to 404).
 */
export async function updateConversationVisibilityInOrg(
  conversationId: string,
  organizationId: string,
  visibility: ResourceVisibility,
): Promise<Conversation | null> {
  const db = getDb()
  const [row] = await db
    .update(conversations)
    .set({ visibility, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)))
    .returning()
  return row ?? null
}

/**
 * Insert a conversation, tolerating concurrent duplicate creates: the client
 * fires create-if-missing checks per appended message, so two in-flight
 * appends can both attempt the insert. On id conflict this returns null and
 * the caller resolves the existing row instead of surfacing a 500.
 */
export async function insertConversation(values: {
  id: string
  organizationId: string
  createdBy: string
  title: string | null
  projectId: string | null
}): Promise<Conversation | null> {
  const db = getDb()
  const [row] = await db.insert(conversations).values(values).onConflictDoNothing().returning()
  return row ?? null
}

/**
 * Rename a conversation, scoped to the organization in SQL. Returns null when
 * the row does not exist in this org (the caller maps that to a 404).
 */
export async function updateConversationTitleInOrg(
  conversationId: string,
  organizationId: string,
  title: string,
): Promise<Conversation | null> {
  const db = getDb()
  const [row] = await db
    .update(conversations)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)))
    .returning()
  return row ?? null
}

/**
 * Set a conversation's title AND topic tags in one write (the naming LLM
 * returns both together), scoped to the organization in SQL. Returns null when
 * the row does not exist in this org (the caller maps that to a 404).
 */
export async function updateConversationMetaInOrg(
  conversationId: string,
  organizationId: string,
  meta: { title: string; tags: string[] },
): Promise<Conversation | null> {
  const db = getDb()
  const [row] = await db
    .update(conversations)
    .set({ title: meta.title, tags: meta.tags, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)))
    .returning()
  return row ?? null
}

/**
 * Delete a conversation (messages cascade). Tenant isolation lives in the
 * WHERE clause — deleting by id alone would let any signed-in user delete
 * another org's conversation by guessing ids.
 */
export async function deleteConversationInOrg(conversationId: string, organizationId: string): Promise<void> {
  const db = getDb()
  await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)))
}

/**
 * List a conversation's messages, oldest first. Callers must have resolved
 * the conversation through `findConversationInOrg` first — this query is
 * scoped by conversation id only.
 */
export async function listMessagesForConversation(
  conversationId: string,
  limit = MESSAGE_LIST_LIMIT,
): Promise<Message[]> {
  const db = getDb()
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(limit)
}

/**
 * Load one message inside a conversation. Scoped by BOTH ids so a guessed
 * message id from another conversation reads as absent.
 *
 * Used by the persist path to recognise a replayed client-generated id before it
 * re-runs the side effects that id already caused (mention requests, inbox
 * items): the addressee ruling is read back off the stored row instead of being
 * computed a second time (spec MN-2).
 */
export async function findMessageInConversation(
  conversationId: string,
  messageId: string,
): Promise<Message | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .limit(1)
  return row ?? null
}

/**
 * Insert messages, skipping ids that already exist (client retries replay the
 * same client-generated id; a duplicate must not fail the whole batch).
 */
export async function insertMessages(values: NewMessage[]): Promise<Message[]> {
  const db = getDb()
  return db.insert(messages).values(values).onConflictDoNothing().returning()
}

/**
 * Merge keys into one message's `metadata` jsonb, scoped to its conversation
 * (callers must have resolved that conversation org-scoped first — without the
 * conversation predicate any signed-in user could patch another tenant's
 * message by guessing its id).
 *
 * The merge happens in JS on the row we just read rather than in SQL, so the
 * jsonb stays a plain object the mapper can read — but read-merge-write is a
 * lost-update race, so the whole thing runs in ONE transaction and the read
 * takes a row lock (`SELECT … FOR UPDATE`). Without the lock two concurrent
 * PATCHes both read the same snapshot and the later UPDATE discards the
 * earlier one's entry, which is the very failure the deep merge below exists
 * to prevent.
 *
 * `deepMergeKeys` names top-level keys whose OBJECT value should be merged
 * entry-by-entry instead of replaced. `cardInteractions` needs this: two
 * clients holding different views of the same conversation each PATCH the whole
 * map they know about, so a plain top-level merge would let the second erase
 * the first's decision — resurrecting a settled card and re-inviting the
 * duplicate write this whole mechanism exists to prevent (ADR-0030).
 * Last-writer-wins still applies PER ENTRY, which is correct: the same card can
 * only be decided once.
 *
 * Returns null when the message does not exist in that conversation (404).
 */
export async function mergeMessageMetadata(
  conversationId: string,
  messageId: string,
  patch: Record<string, unknown>,
  deepMergeKeys: readonly string[] = [],
): Promise<Message | null> {
  const db = getDb()
  const scope = and(eq(messages.id, messageId), eq(messages.conversationId, conversationId))

  return db.transaction(async (tx) => {
    // `for('update')` is what makes the read-merge-write below safe: it holds
    // the row until this transaction commits, so a second PATCH to the same
    // message blocks here instead of racing us with a stale snapshot.
    const [existing] = await tx.select().from(messages).where(scope).limit(1).for('update')
    if (!existing) return null

    const current = (existing.metadata ?? {}) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...current, ...patch }

    for (const key of deepMergeKeys) {
      const before = current[key]
      const after = patch[key]
      if (isPlainObject(before) && isPlainObject(after)) {
        merged[key] = { ...before, ...after }
      }
    }

    const [row] = await tx.update(messages).set({ metadata: merged }).where(scope).returning()
    return row ?? null
  })
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Move one person's read high-water mark on a conversation (spec CC-18).
 *
 * Upsert on the composite PK `(conversation_id, user_id)`: reading is a repeated
 * act, and "how far have I read" is one row per person per thread — never a
 * per-message receipt.
 *
 * `lastReadMessageId` is only overwritten when the caller supplies one, so a
 * plain "I looked at this thread" mark cannot erase the anchor a previous, more
 * precise mark stored (which is what the unread separator renders from, CC-19).
 */
export async function upsertConversationRead(values: {
  conversationId: string
  userId: string
  lastReadAt?: Date
  lastReadMessageId?: string | null
}): Promise<ConversationRead> {
  const db = getDb()
  const at = values.lastReadAt ?? new Date()
  const [row] = await db
    .insert(conversationReads)
    .values({
      conversationId: values.conversationId,
      userId: values.userId,
      lastReadAt: at,
      lastReadMessageId: values.lastReadMessageId ?? null,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [conversationReads.conversationId, conversationReads.userId],
      set: {
        lastReadAt: at,
        lastReadMessageId:
          values.lastReadMessageId ?? sql`${conversationReads.lastReadMessageId}`,
        updatedAt: at,
      },
    })
    .returning()
  return row
}

/** One person's read mark on one conversation, or null when they never read it. */
export async function findConversationRead(
  conversationId: string,
  userId: string,
): Promise<ConversationRead | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(conversationReads)
    .where(and(eq(conversationReads.conversationId, conversationId), eq(conversationReads.userId, userId)))
    .limit(1)
  return row ?? null
}
