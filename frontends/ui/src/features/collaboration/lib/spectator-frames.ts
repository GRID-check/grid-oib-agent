/**
 * A colleague's turn, as an OBSERVER folds it (ADR-0039).
 *
 * The observer folds the same v2 events through the same `foldTurnEvent` as
 * the asker (`docs/design/chat-wire-v2.md` §d). What is left here is only what
 * an observer does differently:
 *
 *  1. **A new `turn_id` starts a new view.** The relay carries a conversation,
 *     so the tail of one turn and the head of the next share a subscription.
 *  2. **A gap is skipped, never filled.** An observer joins mid-turn and never
 *     asks for a replay (ADR-0039 §4); the persisted answer replaces all of
 *     this a moment after the turn ends.
 *  3. **An observer is never handed a card that acts.** Interactive and system
 *     cards propose a write in the ASKER's name. They are holes here, so every
 *     `[[card:N]]` after them stays bound, and `SpectatedTurn` draws the rest
 *     read-only (ADR-0039 §5).
 */

import type { WireEvent } from '@/adapters/api/wire-v2'
import { foldTurnEvent, type StoredThinkingStep, type TurnView } from '@/features/chat/lib/turn-fold'
import { INTERACTIVE_CARD_TYPES } from '@/features/grid-cards/card-decision'
import { SYSTEM_CARD_TYPES } from '@/features/skills/lib/card-catalog'
import { validateGridCards, type GridCard } from '@/shared/cards/schemas'

/** One relayed event folded into the turn on screen. `rejected` (seq 0) is never the observer's. */
export function foldSpectatedEvent(view: TurnView | null, event: WireEvent): TurnView | null {
  if (event.seq === 0) return view
  if (!view || view.turnId !== event.turn_id) return foldTurnEvent(undefined, event)
  const next = foldTurnEvent(view, event)
  return next.gap ? foldTurnEvent({ ...view, lastSeq: event.seq - 1 }, event) : next
}

/** Whether the view has anything to draw yet: an empty bubble replacing the banner reads as a stall. */
export const hasSomethingToShow = (view: TurnView): boolean =>
  Boolean(view.text || view.answerMeta || view.interaction || view.stepOrder.length > 0) ||
  (observerCards(view)?.some((card) => card !== undefined) ?? false)

/** The steps in the order they first appeared. */
export const orderedSteps = (view: TurnView): StoredThinkingStep[] => view.stepOrder.map((id) => view.steps[id])

const NOT_FOR_OBSERVERS: ReadonlySet<string> = new Set<string>([...INTERACTIVE_CARD_TYPES, ...SYSTEM_CARD_TYPES])

/** The cards an observer may see, by index, with a hole for every other one. */
export function observerCards(view: TurnView): (GridCard | undefined)[] | undefined {
  if (view.cards.length === 0) return undefined
  return Array.from(view.cards, (keyed) => {
    const card = keyed ? validateGridCards([keyed.card])[0] : undefined
    return card && !NOT_FOR_OBSERVERS.has(card.type) ? card : undefined
  })
}
