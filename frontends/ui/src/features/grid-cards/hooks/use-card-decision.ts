'use client'

import { useCallback, useState } from 'react'
import { useChatStore } from '@/features/chat/store'
import type { ChatState } from '@/features/chat/types'
import type { CardDecision } from '../card-decision'

export interface UseCardDecisionResult {
  /** The settled outcome for this card, or null while it is still unanswered. */
  decision: CardDecision | null
  /** Record the outcome. Persisted whenever the card knows its owning message. */
  decide: (decision: CardDecision) => void
  /**
   * Whether this card may offer its decision at all. False only where the
   * caller demanded persistence and no message owns the card — see
   * {@link UseCardDecisionOptions.mustPersist}. A card reading false must draw
   * itself WITHOUT its actions: it may still show what is being proposed, but
   * it must not take an answer it cannot keep.
   */
  canDecide: boolean
}

export interface UseCardDecisionOptions {
  /**
   * Refuse the decision outright when no owning message is known, instead of
   * falling back to mount-local state.
   *
   * The fallback is right where nothing COULD be persisted and nothing is at
   * stake — the `/dev/cards` gallery, a preview — and it is wrong on a real
   * surface, where it produces a button that applies a patch or writes a memory
   * and then forgets it did. The deep-research report tab is the second kind:
   * its cards come from a job output whose owning message may not be loaded (or
   * may not exist yet), so it asks for persistence and takes no answer without
   * it. See `card-owner.ts`.
   */
  mustPersist?: boolean
}

/**
 * Read one card's recorded decision out of the store. A plain function so the
 * hook's selector and its post-write check can never disagree about where the
 * decision lives.
 */
const selectCardDecision = (
  state: Pick<ChatState, 'currentConversation' | 'conversations'>,
  messageId: string | undefined,
  cardKey: string
): CardDecision | null => {
  if (!messageId) return null
  const conversation = state.currentConversation?.messages.some((m) => m.id === messageId)
    ? state.currentConversation
    : state.conversations.find((c) => c.messages.some((m) => m.id === messageId))
  return conversation?.messages.find((m) => m.id === messageId)?.cardInteractions?.[cardKey]?.decision ?? null
}

/**
 * The persisted lifecycle state of one interactive card.
 *
 * Reads through the chat store, so the decision is written onto the owning
 * `ChatMessage` and rides both persistence layers (localStorage via the store's
 * `persist` middleware, and the server message row via `_persistCardInteractions`).
 * That is the whole point: before this, an accepted patch or a saved memory
 * lived in component-local `useState` and reset to `pending` on the next
 * reload, re-offering a button that would apply it twice.
 *
 * `messageId` is absent for callers that render cards outside a conversation
 * (the `/dev/cards` gallery, standalone previews). Those fall back to local
 * state so the cards stay clickable — there is simply nothing to persist onto.
 */
export function useCardDecision(
  messageId: string | undefined,
  cardKey: string,
  options?: UseCardDecisionOptions
): UseCardDecisionResult {
  // No owning message on a surface that requires one: the card is read-only.
  // Computed before the store reads so `decide` and the renderer agree.
  const canDecide = Boolean(messageId) || !options?.mustPersist
  // Returns a primitive, so it is referentially stable and cannot loop.
  const persisted = useChatStore((state) => selectCardDecision(state, messageId, cardKey))
  const setCardDecision = useChatStore((state) => state.setCardDecision)

  /**
   * Last-resort fallback for THIS mount, used only when the store could not
   * record the decision:
   *   - the card has no owning message (the /dev gallery), or
   *   - `setCardDecision` no-opped because the message is gone (its session was
   *     deleted while the card was still on screen).
   * In the second case the API write has already happened, so the card must
   * still settle rather than keep offering a button that repeats it.
   *
   * It is deliberately NOT set when the store write succeeds. Otherwise a
   * decision later dropped by `reconcileCardInteractions` — because a streaming
   * frame replaced that card — would survive here and mark the REPLACEMENT card
   * as decided, which is exactly the mis-attribution the reconciler exists to
   * prevent.
   */
  const [local, setLocal] = useState<CardDecision | null>(null)

  const decide = useCallback(
    (decision: CardDecision) => {
      if (!messageId) {
        // Nothing owns this card. Where the caller asked for persistence that
        // is a refusal, not a fallback — the card should not have offered the
        // action, and swallowing a stray call is cheaper than trusting every
        // caller to have hidden every button.
        if (!canDecide) return
        setLocal(decision)
        return
      }
      setCardDecision(messageId, cardKey, decision)
      if (selectCardDecision(useChatStore.getState(), messageId, cardKey) === null) {
        setLocal(decision)
      }
    },
    [messageId, cardKey, setCardDecision, canDecide]
  )

  // Persisted wins when present: it is the copy that survives a reload.
  return { decision: persisted ?? local, decide, canDecide }
}
