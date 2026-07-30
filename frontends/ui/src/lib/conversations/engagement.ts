import 'server-only'

/**
 * When the agent answers a message that tags nobody (ADR-0036).
 *
 * The three tag rules are absolute and live elsewhere (`lib/mentions/service`):
 * `@Piloti` always answers, a humans-only tag never starts a turn, tagging both
 * answers. This module governs only the fourth case — a plain message — and it
 * governs it with **deterministic, inspectable state**, never with a judgement.
 *
 * That is a decision with evidence behind it. "Who was this message for?" is a
 * question about conversation *structure* — who is present, who spoke, who was
 * replying to whom — and an LLM asked it directly measures barely above chance in
 * multi-party dialogue (arXiv:2501.16643; arXiv:2409.18602 shows why: addressee
 * recognition needs the structural dimension, while it is *response selection*
 * that rides on textual content). We hold that structure exactly and for free.
 * Handing the question to a model would be replacing data with a guess about it.
 *
 * Every shipping product we could find agrees, and none of them guess: Claude in
 * Slack, agents in Microsoft Teams and agents in Linear are all triggered by an
 * explicit mention, assignment or delegation, with ambient behaviour reached only
 * through a named, listable, human-authored standing instruction.
 *
 * So the mode is a fact about the thread:
 *   - `ask`     — a plain message goes to the assistant (today's behaviour, and
 *                 right for the single-author thread, which is nearly all of them);
 *   - `mention` — a plain message goes to the chat.
 *
 * And the transition between them is a *structural* signal, not an inference: the
 * moment a second human contributes, the thread is a conversation between people
 * and the assistant stops assuming every sentence is for it.
 */

import { eq, isNull, and, ne, sql } from 'drizzle-orm'

import { getDb } from '@/lib/db'
import { conversations, messages, type ConversationEngagement } from '@/lib/db/schema'

/**
 * The mode a thread has when nothing is stored: `mention` once two or more
 * distinct people have written in it, `ask` otherwise.
 *
 * Coarse on purpose. A colleague saying "danke" flips it, and that is the
 * accepted cost of not judging what their message meant — which is the thing this
 * module declines to do. Any participant can set the mode back in one click.
 */
export function deriveEngagement(distinctHumanAuthors: number): ConversationEngagement {
  return distinctHumanAuthors >= 2 ? 'mention' : 'ask'
}

/** How many distinct people have written a message in this thread. */
export async function countDistinctHumanAuthors(conversationId: string): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${messages.authorUserId})::int` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, 'user'),
        // Legacy rows carry no author (authorship arrived with migration 0027).
        // Counting them as one anonymous person would flip a solo thread the
        // first time its owner wrote again.
        sql`${messages.authorUserId} is not null`
      )
    )
  return row?.count ?? 0
}

/**
 * The mode in force for this thread, and whether it had to be derived.
 *
 * `stored` is what a UI should offer to change; `mode` is what routing obeys.
 */
export interface EngagementState {
  mode: ConversationEngagement
  stored: ConversationEngagement | null
}

export async function resolveEngagement(
  conversationId: string,
  stored: ConversationEngagement | null
): Promise<EngagementState> {
  if (stored) return { mode: stored, stored }
  return { mode: deriveEngagement(await countDistinctHumanAuthors(conversationId)), stored: null }
}

/** The stored mode alone — a primary-key lookup, no derivation. */
export async function findStoredEngagement(
  conversationId: string
): Promise<ConversationEngagement | null> {
  const db = getDb()
  const [row] = await db
    .select({ engagement: conversations.engagement })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  return row?.engagement ?? null
}

/**
 * The mode for a thread, reading the stored value itself.
 *
 * Lazy on purpose: called from the message-persist path only for a plain message
 * in a shared thread that is not already waiting on someone — so a solo thread
 * (nearly all of them) pays nothing, and once the mode is stored this is a single
 * primary-key lookup rather than the author-count aggregate.
 */
export async function resolveEngagementFor(conversationId: string): Promise<EngagementState> {
  return resolveEngagement(conversationId, await findStoredEngagement(conversationId))
}

/**
 * Persist the derived flip, once.
 *
 * Called after a human message lands in a shared thread. Guarded on
 * `engagement IS NULL`, so it can never overwrite a mode a participant set by
 * hand, and it is a no-op on every message after the first flip — which is the
 * point: without it, `countDistinctHumanAuthors` would run on every plain message
 * for the life of the thread.
 *
 * Returns true when THIS call performed the flip, so the caller can announce it
 * exactly once.
 */
export async function persistDerivedEngagement(
  conversationId: string,
  mode: ConversationEngagement
): Promise<boolean> {
  const db = getDb()
  const updated = await db
    .update(conversations)
    .set({ engagement: mode })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.engagement)))
    .returning({ id: conversations.id })
  return updated.length > 0
}

/** Set the mode explicitly. Any participant may; it is not an owner-only setting. */
export async function setEngagement(
  conversationId: string,
  organizationId: string,
  mode: ConversationEngagement
): Promise<boolean> {
  const db = getDb()
  const updated = await db
    .update(conversations)
    .set({ engagement: mode })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.organizationId, organizationId),
        // Nothing to do when it already says that — keeps a double-click from
        // counting as a change worth publishing.
        ne(sql`coalesce(${conversations.engagement}, '')`, mode)
      )
    )
    .returning({ id: conversations.id })
  return updated.length > 0
}
