/**
 * A card telling whatever holds its place that it has drawn.
 *
 * A card through A2UI (`A2uiCard`) exists on screen a frame or two after it
 * mounts: A2UI resolves its tree in a subscription. What holds the card's
 * place while it streams in (`CardSlotArrival.tsx`) keeps its placeholder up
 * until then, and only then fades the card in and takes its measured height.
 * `A2uiCard` reports through this once per surface: when A2UI has drawn it,
 * or when it has fallen back to drawing the card directly.
 */

import { createContext, useContext } from 'react'

const CardDrawnContext = createContext<(() => void) | null>(null)

export const CardDrawnProvider = CardDrawnContext.Provider

/** The enclosing place-holder's "drawn" callback, or null outside one. */
export const useCardDrawnReporter = (): (() => void) | null => useContext(CardDrawnContext)
