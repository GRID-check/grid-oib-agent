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
 */

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionDeliberate, motionInstant } from '@/components/motion'
import { CARD_PLACEHOLDER_HEIGHT, CardPlaceholder } from '@/features/grid-cards/components/CardPlaceholder'
import { DrawnProvider } from '@/features/a2ui/catalog'
import { cn } from '@/lib/utils'

/** The cards that have arrived on this page, as `messageId:index`: it outlives a remounted slot. */
const arrived = new Set<string>()

const LiveContext = createContext(false)

/** Whether the answer the slots below belong to is still arriving. */
export const CardSlotLiveProvider = LiveContext.Provider

/** `arrivalKey` is `messageId:index`; `children` the card, absent until it arrives. */
export const CardSlot = ({ arrivalKey, children }: { arrivalKey: string; children?: ReactNode }) => {
  const live = useContext(LiveContext)
  const reducedMotion = useReducedMotion()
  const [arrives] = useState(() => live && !reducedMotion && !arrived.has(arrivalKey))
  const [drawn, setDrawn] = useState(false)
  const [standing, setStanding] = useState(!arrives)
  const reveal = useCallback(() => {
    arrived.add(arrivalKey)
    setDrawn(true)
  }, [arrivalKey])

  const hasCard = children !== undefined && children !== null
  if (!hasCard && !live) return null
  const shown = hasCard && (drawn || !arrives)
  const transition = arrives ? motionDeliberate : motionInstant

  return (
    // `mb-3` is the paragraph rhythm of the markdown body: the card replaced a
    // paragraph. `block!` beats the streaming caret's `*:last-child]:inline`
    // rule, which would collapse a card that ends a still-arriving answer.
    // Clipped until the card stands, so its popovers are not cut off after.
    <motion.div
      className={cn('block! relative mb-3', !standing && 'overflow-hidden')}
      data-testid={hasCard ? undefined : 'pending-card-slot'}
      aria-busy={shown ? undefined : true}
      initial={false}
      animate={{ height: shown ? 'auto' : CARD_PLACEHOLDER_HEIGHT }}
      transition={transition}
      onAnimationComplete={() => setStanding(shown)}
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
