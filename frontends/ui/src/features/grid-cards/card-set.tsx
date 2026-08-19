'use client'

/**
 * What the other cards in this answer are — the little context a card needs to
 * stop competing with its neighbours.
 *
 * Almost every rule in `docs/design/grid-card-charter.md` is local to one card,
 * and that is deliberate: a card is designed for solo appearance beside prose
 * (§0.7), and a card that reads its siblings is a card whose look depends on
 * what the model happened to emit. §A2 carries exactly ONE exception, and it is
 * a real one: `summary`'s 17px title is the answer's H1, `verdict_header`'s
 * 30px verdict is the answer's figure, and when both arrive they land four
 * pixels apart at the top of the same column, each claiming to be the thing the
 * reader should look at first. So `summary` drops to the Title step when a
 * verdict header is present.
 *
 * ONE derivation, read off the whole `cards` array rather than the subset being
 * drawn: the chat splits an answer's cards between the ones a `[[card:N]]`
 * marker placed in the prose and the ones that fall through to the block below
 * (AgentResponse.tsx), so neither renderer sees the full set on its own, and
 * "is there a verdict header in this ANSWER" is not a question either subset
 * can answer. Both entry points wrap what they draw in this provider.
 *
 * The default is the honest one for a card rendered outside any answer — a
 * gallery, a preview, a spec: no verdict header, so `summary` keeps its H1.
 */

import { createContext, useContext, useMemo, type FC, type ReactNode } from 'react'
import type { GridCard } from '@/shared/cards/schemas'

export interface CardSet {
  /** True when this answer also carries a `verdict_header` (§A2 cross-card rule). */
  hasVerdictHeader: boolean
}

const EMPTY_CARD_SET: CardSet = { hasVerdictHeader: false }

const CardSetContext = createContext<CardSet>(EMPTY_CARD_SET)

/** What else this answer is carrying. `{ hasVerdictHeader: false }` with no provider. */
export function useCardSet(): CardSet {
  return useContext(CardSetContext)
}

export const CardSetProvider: FC<{
  /** The answer's WHOLE card array, not the subset being drawn here. */
  cards: readonly (GridCard | undefined)[]
  children: ReactNode
}> = ({ cards, children }) => {
  const value = useMemo<CardSet>(
    // `card?.type` rather than `card.type`: the array is indexed by position
    // and a hole in it is a normal mid-stream state, not an error (§0.5.1).
    () => ({ hasVerdictHeader: cards.some((card) => card?.type === 'verdict_header') }),
    [cards],
  )

  return <CardSetContext.Provider value={value}>{children}</CardSetContext.Provider>
}
