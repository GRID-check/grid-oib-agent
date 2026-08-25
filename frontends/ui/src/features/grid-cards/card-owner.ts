/**
 * Which message owns a card set rendered OUTSIDE a chat bubble.
 *
 * A card in the thread knows its message: `AgentResponse` draws
 * `message.cards` and hands `GridCards` that message's id, so an interactive
 * card's answer lands on the message it belongs to (ADR-0030). The
 * deep-research REPORT tab draws the same cards from `deepResearchCards` — a
 * transient list lifted off the finished job's output — and had no message at
 * all, so a `memory_proposal` answered there fell back to mount-local state and
 * was forgotten. The same card, answered in the thread, persisted. One card,
 * two decision states, decided by which panel the reader happened to click in.
 *
 * The owning message DOES exist. `write_job_turn`
 * (`aiq_api/jobs/conversation_output.py`) writes the finished run into its
 * conversation as an assistant message carrying `metadata.cards` — the very
 * cards the report tab is drawing. This module finds that message in the store
 * rather than reconstructing its id: the backend derives it as
 * `uuid5(conversation, job, role)`, and a client that spelled that formula out
 * a second time would own a copy of an id the backend owns — one deploy away
 * from writing decisions onto a message that does not exist, silently.
 *
 * ## The rule
 *
 * A message owns these cards when it names the same run AND carries a
 * BYTE-IDENTICAL card array. Both halves are load-bearing:
 *
 *   - **Same run** (`deepResearchJobId`) keeps an unrelated answer that happens
 *     to carry a similar card set out of the running.
 *   - **Byte-identical cards** is what makes the two surfaces one fact rather
 *     than two. `cardKey` is POSITIONAL (`${type}-${index}`), so it only names
 *     the same card on both surfaces if both surfaces hold the same array.
 *     ADR-0030 §Open Questions names this exact trap: the deep-research
 *     tracking bubble can carry its own inline cards from the escalation frame,
 *     and keying the report's cards on that message would file
 *     `memory_proposal-0` against a different `memory_proposal-0`. Byte
 *     equality is the same standard `reconcileCardInteractions` already holds a
 *     decision to when a streaming frame replaces the array, for the same
 *     reason: losing a record and re-asking is recoverable, attributing one
 *     card's decision to another is not.
 *
 * No match means NO OWNER, and the caller must then not offer a decision at all
 * (see `decisionsMustPersist` in `GridCards`). That is the honest outcome while
 * a run is still live: its cards are on the wire and in the panel, and the
 * message that will carry them is written by the worker at the end of the run.
 * A decision recorded before then has nowhere durable to go, and offering a
 * button that quietly drops what the user pressed is worse than offering none.
 */

import type { GridCard } from '@/shared/cards/schemas'

/** The little of a `ChatMessage` this question needs. */
export interface CardOwnerMessage {
  id: string
  /** The deep-research run this message belongs to, when it belongs to one. */
  deepResearchJobId?: string
  cards?: readonly GridCard[]
}

/** The little of a `Conversation` this question needs. */
export interface CardOwnerConversation {
  id: string
  messages: readonly CardOwnerMessage[]
}

/**
 * Where to look. Every loaded conversation is searched, not just the open one:
 * the report panel outlives a session switch, so the run whose report is on
 * screen may well belong to a thread that is no longer in front of the reader.
 */
export interface CardOwnerSource {
  currentConversation?: CardOwnerConversation | null
  conversations?: readonly CardOwnerConversation[]
}

/**
 * The message that owns `cards`, or null when none can be named.
 *
 * Ties (two messages of the same run carrying the identical array) resolve to
 * the LAST one, which is the persisted answer: the run's tracking bubble is
 * written when the job starts, the answer when it finishes.
 */
export const findCardOwnerMessageId = (
  source: CardOwnerSource,
  jobId: string | null | undefined,
  cards: readonly GridCard[]
): string | null => {
  if (!jobId || cards.length === 0) return null

  const wanted = JSON.stringify(cards)
  const searched = new Set<string>()
  const candidates = [source.currentConversation, ...(source.conversations ?? [])]

  for (const conversation of candidates) {
    if (!conversation || searched.has(conversation.id)) continue
    searched.add(conversation.id)

    let owner: string | null = null
    for (const message of conversation.messages) {
      if (message.deepResearchJobId !== jobId) continue
      // Length first: the common near-miss is a tracking bubble carrying no
      // cards at all, and that costs nothing to reject.
      if (!message.cards || message.cards.length !== cards.length) continue
      if (JSON.stringify(message.cards) !== wanted) continue
      owner = message.id
    }
    if (owner) return owner
  }

  return null
}
