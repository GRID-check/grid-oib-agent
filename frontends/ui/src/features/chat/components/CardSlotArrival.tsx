'use client'

/**
 * A card's place in a streamed answer, before and as the card arrives
 * (ADR-0066).
 *
 * The model writes `[[card:N]]` in the prose and the card object only after the
 * prose closes, seconds later. A marker that rendered nothing until then left
 * the prose below it to be shoved down by the card's full height the moment it
 * landed, which was the largest jump a streamed answer made. So the marker
 * holds a place (`PendingCardSlot`), and the card GROWS out of it
 * (`CardArrival`) instead of being inserted: a movement the eye can follow,
 * not a jump it has to recover from.
 *
 * The placeholder's height is representative, not a reservation: a card's
 * height is unknown until the card exists. It is the height of the shortest
 * common card, so what remains is growth, never a collapse.
 */

import { useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Skeleton } from '@/components/ui/skeleton'
import { motionDeliberate } from '@/components/motion'

/** The placeholder's height in px: a one-row table or a callout-sized card. */
export const PENDING_CARD_HEIGHT = 96

/** Where a card the prose has placed will be drawn, while it is still being written. */
export const PendingCardSlot = () => (
  <div className="block! mb-3" data-testid="pending-card-slot" aria-busy="true">
    <Skeleton className="w-full rounded-lg" style={{ height: PENDING_CARD_HEIGHT }} />
  </div>
)

/**
 * The card, grown from the placeholder when it arrived while the answer was
 * still streaming; drawn at once when it was already there (a reload, a
 * finished answer). The choice is made once, at mount, so the terminal frame
 * that ends the stream does not re-run the entrance.
 */
export const CardArrival = ({ live, children }: { live: boolean; children: ReactNode }) => {
  const [arrivedLive] = useState(live)
  const [growing, setGrowing] = useState(live)
  return (
    <motion.div
      className="block! mb-3"
      initial={arrivedLive ? { height: PENDING_CARD_HEIGHT, opacity: 0 } : false}
      animate={{ height: 'auto', opacity: 1 }}
      transition={motionDeliberate}
      // Clipped only while it grows: a card's own popovers and focus rings
      // must not be cut off once it stands.
      style={growing ? { overflow: 'hidden' } : undefined}
      onAnimationComplete={() => setGrowing(false)}
    >
      {children}
    </motion.div>
  )
}
