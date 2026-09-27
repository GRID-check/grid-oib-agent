/**
 * Keep a card's object identity while its content is unchanged.
 *
 * `validateGridCards` returns new objects on every call, and a live answer
 * carries its whole card list again on every `cards` frame and once more on
 * its terminal. Every new object is a new prop to every card below it:
 * `GridCardItem` re-renders, `A2uiCard` re-serialises it to find its content
 * unchanged, and the slot renderer that closes over the list changes identity.
 * So a card enters the store as the object already there when its JSON is the
 * same, at the same position (positions are identities, `card-markers.ts`).
 *
 * @returns `prev` itself when every card is unchanged; otherwise `next` with
 *   each unchanged card swapped for its previous object.
 */

import type { GridCard } from './schemas'

type CardList = readonly (GridCard | undefined)[]

export function reuseEqualCards<T extends CardList>(prev: T | undefined, next: T): T {
  if (!prev || prev === next || prev.length === 0) return next
  let unchanged = prev.length === next.length
  const merged = next.map((card, index) => {
    const before = prev[index]
    if (before === card) return card
    if (
      before !== undefined &&
      card !== undefined &&
      JSON.stringify(before) === JSON.stringify(card)
    ) {
      return before
    }
    unchanged = false
    return card
  })
  return unchanged ? prev : (merged as unknown as T)
}
