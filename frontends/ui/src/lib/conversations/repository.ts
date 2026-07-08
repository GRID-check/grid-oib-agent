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
import { and, asc, desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { conversations, messages, type Conversation, type Message, type NewMessage } from '@/lib/db/schema'

/** Hard cap for unpaginated org-wide conversation lists. */
export const CONVERSATION_LIST_LIMIT = 200

/** Hard cap for a single conversation's message history. */
export const MESSAGE_LIST_LIMIT = 1000

export async function listConversationsInOrg(
  organizationId: string,
  limit = CONVERSATION_LIST_LIMIT,
): Promise<Conversation[]> {
  const db = getDb()
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.organizationId, organizationId))
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

export async function insertConversation(values: {
  id: string
  organizationId: string
  createdBy: string
  title: string | null
  projectId: string | null
}): Promise<Conversation> {
  const db = getDb()
  const [row] = await db.insert(conversations).values(values).returning()
  return row
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

export async function insertMessages(values: NewMessage[]): Promise<Message[]> {
  const db = getDb()
  return db.insert(messages).values(values).returning()
}
