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
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { conversations, messages, type Conversation, type Message, type NewMessage } from '@/lib/db/schema'

/** Hard cap for unpaginated org-wide conversation lists. */
export const CONVERSATION_LIST_LIMIT = 200

/** Hard cap for a single conversation's message history. */
export const MESSAGE_LIST_LIMIT = 1000

/**
 * List an organization's conversations, optionally scoped to a project.
 *
 * Project scoping is deliberately fail-open for legacy rows: conversations
 * with a NULL `project_id` (created before project stamping) are included in
 * every project-scoped list so users never lose sight of their history.
 * Rows stamped with a DIFFERENT project are always excluded.
 */
export async function listConversationsInOrg(
  organizationId: string,
  options: { projectId?: string; limit?: number } = {},
): Promise<Conversation[]> {
  const { projectId, limit = CONVERSATION_LIST_LIMIT } = options
  const orgScope = eq(conversations.organizationId, organizationId)
  const db = getDb()
  return db
    .select()
    .from(conversations)
    .where(
      projectId
        ? and(orgScope, or(eq(conversations.projectId, projectId), isNull(conversations.projectId)))
        : orgScope,
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(limit)
}

/** Load a conversation by id scoped to an organization. */
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
