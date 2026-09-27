'use client'

/**
 * A card's place in a streamed answer, before and as the card arrives
 * (ADR-0066).
 *
 * The model writes `[[card:N]]` in the prose and the card object only after the
 * prose closes, seconds later. A marker that rendered nothing until then left
 * the prose below it to be shoved down by the card's full height the moment it
 * landed, which was the largest jump a streamed answer made. So the marker
 * holds a place, and the card arrives INTO it.
 *
 * One element holds the place from the marker to the card (`CardSlot`), so
 * what the reader sees is one frame changing, never one box swapped for
 * another:
 *
 *   1. **Pending.** No card yet, and its type unknown: a card-shaped
 *      placeholder `PENDING_CARD_HEIGHT` tall.
 *   2. **Drawing.** The card exists and is mounted, invisible, while A2UI
 *      draws it. The frame grows to the height a card of its type usually has
 *      (`CARD_PLACEHOLDER_HEIGHTS`) with the placeholder still up.
 *   3. **Revealing.** The card has reported itself on screen
 *      (`CardDrawnProvider`). The frame takes the card's measured height, once,
 *      while the card fades in over the placeholder fading out: opacity only.
 *   4. **Standing.** The frame lets go of its height and clip; the card's own
 *      popovers and focus rings are not cut off, and it grows on its own.
 *
 * An arrival plays once per card (`messageId:index`): a slot that remounts
 * (the Markdown renderer keys its blocks by position, so a terminal that moves
 * a marker into another block remounts it) draws the card at once rather than
 * growing it from the placeholder again. A card that was already there (a
 * reload, a finished answer) and a reader who asked for reduced motion get the
 * card at once as well.
 *
 * Whether the answer is live reaches the slot through context
 * (`CardSlotLiveProvider`) rather than through the slot renderer, so the end of
 * the stream does not hand every slot a new renderer and re-render every card.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useReducedMotion } from 'motion/react'
import {
  CardPlaceholder,
  cardPlaceholderHeight,
  DEFAULT_CARD_PLACEHOLDER_HEIGHT,
} from '@/features/grid-cards/components/CardPlaceholder'
import { CardDrawnProvider } from '@/features/grid-cards/card-drawn'
import { cn } from '@/lib/utils'

/** The placeholder's height in px while the card's type is not known yet. */
export const PENDING_CARD_HEIGHT = DEFAULT_CARD_PLACEHOLDER_HEIGHT

/**
 * How long a reveal may take before the slot stands regardless: a reveal
 * whose height does not change fires no `transitionend`. Well past
 * `--motion-deliberate` (320 ms), because a busy main thread starts the
 * transition late, and standing early cuts the growth off with a jump.
 */
const REVEAL_TIMEOUT_MS = 1000
/** How long a mounted card may take to report itself before it is shown anyway. */
const DRAW_TIMEOUT_MS = 1200

/**
 * The cards whose arrival has played, as `messageId:index`. Module-level on
 * purpose: it has to outlive the slot, since a remounted slot is exactly the
 * case it exists for. Bounded, oldest first out; a card evicted from it can at
 * worst play its arrival once more, and only while its answer is still live.
 */
const arrived = new Set<string>()
const ARRIVED_LIMIT = 500

const noteArrived = (key: string): void => {
  arrived.add(key)
  if (arrived.size <= ARRIVED_LIMIT) return
  const oldest = arrived.values().next().value
  if (oldest !== undefined) arrived.delete(oldest)
}

/** Whether the card at `key` has already arrived on this page. */
export const hasCardArrived = (key: string): boolean => arrived.has(key)

/** Test seam: forget every arrival. */
export const resetArrivedCards = (): void => arrived.clear()

const LiveContext = createContext(false)

/** Whether the answer the slots below belong to is still arriving. */
export const CardSlotLiveProvider = LiveContext.Provider

type Phase = 'pending' | 'standing' | 'drawing' | 'revealing'

interface CardSlotProps {
  /** `messageId:index`: which card this is, for as long as the page lives. */
  arrivalKey: string
  /** The card's type, once the card exists. */
  type?: string
  /** The card; absent while it has not arrived. */
  children?: ReactNode
}

/**
 * A card's place in the answer: a placeholder while the answer is live and the
 * card has not arrived, the card arriving into it once it has, and nothing for
 * a finished answer whose card never came.
 */
export const CardSlot = ({ arrivalKey, type, children }: CardSlotProps) => {
  const live = useContext(LiveContext)
  const reducedMotion = useReducedMotion()
  const hasCard = children !== undefined && children !== null
  const arrives = () => live && !reducedMotion && !hasCardArrived(arrivalKey)
  const [phase, setPhase] = useState<Phase>(() =>
    !hasCard ? 'pending' : arrives() ? 'drawing' : 'standing'
  )
  const [height, setHeight] = useState<number | null>(null)
  const content = useRef<HTMLDivElement>(null)

  // The card has come: decided once, the render it appears in.
  if (phase === 'pending' && hasCard) setPhase(arrives() ? 'drawing' : 'standing')

  useEffect(() => {
    if (phase === 'drawing' || phase === 'revealing') noteArrived(arrivalKey)
  }, [phase, arrivalKey])

  const reveal = useCallback(() => {
    setHeight(content.current?.offsetHeight ?? null)
    setPhase((current) => (current === 'drawing' ? 'revealing' : current))
  }, [])

  // A card that never reports itself is shown anyway; a reveal whose height
  // did not change fires no transitionend, so it is ended by time as well.
  useEffect(() => {
    if (phase !== 'drawing' && phase !== 'revealing') return
    const timer = window.setTimeout(
      phase === 'drawing' ? reveal : () => setPhase('standing'),
      phase === 'drawing' ? DRAW_TIMEOUT_MS : REVEAL_TIMEOUT_MS
    )
    return () => window.clearTimeout(timer)
  }, [phase, reveal])

  if (phase === 'pending' && !live) return null

  const arriving = phase === 'drawing' || phase === 'revealing'
  let frameHeight: number | undefined
  if (phase === 'pending') frameHeight = PENDING_CARD_HEIGHT
  else if (phase === 'drawing') frameHeight = cardPlaceholderHeight(type)
  else if (phase === 'revealing') frameHeight = height ?? cardPlaceholderHeight(type)
  const frameStyle: CSSProperties | undefined =
    frameHeight === undefined ? undefined : { height: frameHeight, overflow: 'hidden' }

  return (
    // `mb-3` is the paragraph rhythm of the markdown body: the card replaced a
    // paragraph, so it leaves the same gap behind it. `block!` beats the
    // streaming caret's `*:last-child]:inline` rule, which would collapse a
    // card that ends the answer for as long as the answer is still arriving.
    <div
      className={cn('block! relative mb-3', frameStyle && 'card-arrival-frame')}
      style={frameStyle}
      data-testid={phase === 'pending' ? 'pending-card-slot' : undefined}
      data-arrival={arriving ? phase : undefined}
      aria-busy={phase === 'pending' || phase === 'drawing' ? true : undefined}
      onTransitionEnd={(event) => {
        if (
          phase === 'revealing' &&
          event.target === event.currentTarget &&
          event.propertyName === 'height'
        ) {
          setPhase('standing')
        }
      }}
    >
      <div
        ref={content}
        className={cn(
          arriving &&
            'duration-deliberate transition-opacity ease-out motion-reduce:transition-none'
        )}
        style={phase === 'drawing' ? { opacity: 0 } : undefined}
      >
        {/* Unchanged from drawing to revealing: a new value re-renders the card. */}
        <CardDrawnProvider value={arriving ? reveal : null}>
          {children}
        </CardDrawnProvider>
      </div>
      {phase !== 'standing' && (
        <div
          className={cn(
            'pointer-events-none absolute inset-0',
            arriving &&
              'duration-deliberate transition-opacity ease-out motion-reduce:transition-none',
            phase === 'revealing' && 'opacity-0'
          )}
        >
          <CardPlaceholder type={type} height="100%" />
        </div>
      )}
    </div>
  )
}
