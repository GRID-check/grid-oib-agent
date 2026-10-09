'use client'

/**
 * A card's place in a streamed answer (ADR-0066). The model writes `[[card:N]]`
 * seconds before the card, so the marker holds a place and the card arrives
 * INTO it: one frame from marker to card, a placeholder until A2UI has drawn
 * the card (`DrawnProvider`), then the card fading in over the placeholder
 * while the frame grows to the card's height (motion's `height: 'auto'`).
 *
 * Only a card the reader watches arrive animates, once per `messageId:index`:
 * a remounted slot (the Markdown renderer keys blocks by position), a reload, a
 * finished answer and reduced motion show it at once. `live` comes through
 * context, so the settle hands no slot a new renderer.
 *
 * A place held for a card that never comes (refused, or the answer settled
 * without it) folds away on the exit curve instead of vanishing.
 */

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionDeliberateEntrance, motionInstant, motionQuickExit } from '@/components/motion'
import { CARD_PLACEHOLDER_HEIGHT, CardPlaceholder } from '@/features/grid-cards/components/CardPlaceholder'
import { DrawnProvider } from '@/features/a2ui/catalog'
import { cn } from '@/lib/utils'

/** The cards that have arrived on this page, as `messageId:index`: it outlives a remounted slot. */
const arrived = new Set<string>()

const LiveContext = createContext(false)

/**
 * Whether the answer the slots below belong to is still arriving. The citation
 * marker reads it too (`useAnswerLive`): what is pending is decided at render
 * time from here, never by the remark plugins, so the plugin list keeps its
 * identity when the answer settles and the settle frame re-parses nothing.
 */
export const CardSlotLiveProvider = LiveContext.Provider

/** Whether the answer this element is rendered into is still arriving. */
export const useAnswerLive = (): boolean => useContext(LiveContext)

export const CardSlot = ({
  arrivalKey,
  children,
  refused = false,
  arriving,
}: {
  /** `messageId:index`. */
  arrivalKey: string
  /** The card, absent until it arrives. */
  children?: ReactNode
  /**
   * The card will never come: the validator refused it, or this reader may
   * not see it. A slot that has been holding its place goes, rather than
   * vanishing (see below); one that never showed renders nothing.
   */
  refused?: boolean
  /**
   * Whether the card arrives in front of the reader, defaulting to the
   * answer's `live`. The unplaced cards pass it explicitly: they mount when
   * "unplaced" becomes final, which can be the settle frame of an answer the
   * reader watched arrive.
   */
  arriving?: boolean
}) => {
  const live = useContext(LiveContext)
  const reducedMotion = useReducedMotion()
  const [arrives] = useState(() => (arriving ?? live) && !reducedMotion && !arrived.has(arrivalKey))
  // Whether the reader saw this slot hold a place. Only such a slot animates
  // away when its card turns out never to be coming: a 120px placeholder that
  // vanished in one frame pulled everything under it up by as much.
  const [heldPlace] = useState(() => live && !reducedMotion && !refused)
  const [gone, setGone] = useState(false)
  const [drawn, setDrawn] = useState(false)
  const [standing, setStanding] = useState(!arrives)
  const reveal = useCallback(() => {
    arrived.add(arrivalKey)
    setDrawn(true)
  }, [arrivalKey])

  const hasCard = !refused && children !== undefined && children !== null
  const neverComing = refused || (!hasCard && !live)
  if (neverComing && (!heldPlace || gone)) return null
  const shown = hasCard && (drawn || !arrives)
  // Arrival is an entrance: decided at the start, settling at the end.
  const transition = arrives ? motionDeliberateEntrance : motionInstant

  return (
    // `mb-3` is the paragraph rhythm of the markdown body: the card replaced a
    // paragraph. Clipped until the card stands, so its popovers are not cut off after.
    <motion.div
      className={cn('relative mb-3', (!standing || neverComing) && 'overflow-hidden')}
      data-testid={hasCard ? undefined : 'pending-card-slot'}
      aria-busy={shown || neverComing ? undefined : true}
      initial={false}
      // A place that turns out to hold nothing folds away, its paragraph
      // margin with it, on the exit curve; it unmounts once it has.
      animate={
        neverComing
          ? { height: 0, opacity: 0, marginBottom: 0 }
          : { height: shown ? 'auto' : CARD_PLACEHOLDER_HEIGHT }
      }
      transition={neverComing ? motionQuickExit : transition}
      onAnimationComplete={() => (neverComing ? setGone(true) : setStanding(shown))}
    >
      {hasCard && (
        <motion.div initial={false} animate={{ opacity: shown ? 1 : 0 }} transition={transition}>
          <DrawnProvider value={arrives ? reveal : null}>{children}</DrawnProvider>
        </motion.div>
      )}
      <AnimatePresence initial={false}>
        {!shown && (
          <motion.div
            key="placeholder"
            className="pointer-events-none absolute inset-0"
            exit={{ opacity: 0 }}
            transition={transition}
          >
            <CardPlaceholder height="100%" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
