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
 *   - `ask`     — a plain message goes to the assistant;
 *   - `mention` — a plain message goes to the chat.
 *
 * **`ask` is the default and stays the default.** Piloti is the point of this
 * product, not a guest in someone else's chat app: Slack and Teams default to
 * mention-only because there the agent is the visitor and the human conversation is
 * the ground truth. Importing that default here would invert what the product is
 * for. A thread never changes its own routing.
 *
 * What the structural signal does instead is *offer*. Two or more people having
 * written is a good reason to ASK whether the assistant should step back, and a bad
 * reason to decide it for them — a colleague typing "danke" must not silently
 * rewire who answers next. So the count produces a suggestion, and a human turns it
 * into a mode.
 */

import { eq, and, ne, sql } from 'drizzle-orm'

import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { conversations, messages, type ConversationEngagement } from '@/lib/db/schema'

/**
 * Whether it is worth OFFERING `mention` for a thread nobody has set a mode on.
 *
 * Not "what mode is this thread in" — that is always `ask` until somebody says
 * otherwise. This is the suggestion, and the signal behind it is structural (how
 * many people have written), never a judgement about what they wrote.
 */
export function suggestEngagement(distinctHumanAuthors: number): ConversationEngagement | null {
  return distinctHumanAuthors >= 2 ? 'mention' : null
}

/** How many distinct people have written a message in this thread. */
export async function countDistinctHumanAuthors(
  conversationId: string,
  organizationId: string
): Promise<number> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ count: sql<number>`count(distinct ${messages.authorUserId})::int` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.organizationId, organizationId),
          eq(messages.role, 'user'),
          // Legacy rows carry no author (authorship arrived with migration 0027).
          // Counting them as one anonymous person would flip a solo thread the
          // first time its owner wrote again.
          sql`${messages.authorUserId} is not null`
        )
      )
  )
  return row?.count ?? 0
}

/**
 * The mode in force, whether anybody chose it, and whether another is worth
 * offering.
 *
 * `mode` is what routing obeys. `stored` is null while nobody has chosen, which is
 * what lets a UI say "you can change this" rather than "you changed this".
 * `suggestion` is a mode worth offering, or null when the current one is fine.
 */
export interface EngagementState {
  mode: ConversationEngagement
  stored: ConversationEngagement | null
  suggestion: ConversationEngagement | null
}

/**
 * Resolve the mode, and optionally the suggestion alongside it.
 *
 * `withSuggestion` is false on the message-write path: routing does not care
 * whether a different mode would suit, and the author count is an aggregate not
 * worth running per message. True on read, once per opened thread.
 */
export async function resolveEngagement(
  conversationId: string,
  organizationId: string,
  stored: ConversationEngagement | null,
  options: { withSuggestion?: boolean } = {}
): Promise<EngagementState> {
  const mode = stored ?? 'ask'
  if (!options.withSuggestion) return { mode, stored, suggestion: null }
  // A thread that has chosen is not nagged about the alternative.
  const suggestion = stored
    ? null
    : suggestEngagement(await countDistinctHumanAuthors(conversationId, organizationId))
  return { mode, stored, suggestion }
}

/** The stored mode alone — a primary-key lookup, no derivation. */
export async function findStoredEngagement(
  conversationId: string,
  organizationId: string
): Promise<ConversationEngagement | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ engagement: conversations.engagement })
      .from(conversations)
      .where(
        and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId))
      )
      .limit(1)
  )
  return row?.engagement ?? null
}

/**
 * The mode for a thread on the WRITE path — one primary-key lookup, no aggregate.
 *
 * Called only for a plain message in a shared thread that is not already waiting on
 * someone, so a solo thread (nearly all of them) pays nothing at all.
 */
export async function resolveEngagementFor(
  conversationId: string,
  organizationId: string
): Promise<EngagementState> {
  return resolveEngagement(
    conversationId,
    organizationId,
    await findStoredEngagement(conversationId, organizationId)
  )
}

/** Set the mode explicitly. Any participant may; it is not an owner-only setting. */
export async function setEngagement(
  conversationId: string,
  organizationId: string,
  mode: ConversationEngagement
): Promise<boolean> {
  const db = getDb()
  const updated = await withTenant({ organizationId }, () =>
    db
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
  )
  return updated.length > 0
}
