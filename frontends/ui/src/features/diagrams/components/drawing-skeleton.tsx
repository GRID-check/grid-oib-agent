'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { motionDeliberateEntrance, motionInstant, useMotionToken } from '@/components/motion'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** The skeleton's height, in px: what {@link DrawingReveal} grows from. */
export const DRAWING_SKELETON_HEIGHT = 132

/**
 * How many frames {@link DrawingReveal} waits, at most, for a drawing's height
 * to stand still before growing to it anyway. A view lays out a frame or two
 * after it mounts; six frames is 100ms, inside the Doherty threshold.
 */
const SETTLE_FRAMES_MAX = 6

/**
 * A drawing's space while mermaid lays the graph out — one component for the
 * fence and the `diagram` card, because the two surfaces that draw the same
 * mermaid must wait the same way (Jakob's law inside one product).
 *
 * Three bars and not a spinner, and not the source either. The shape the reader
 * is waiting for is a graph, so a single grey block reads as an image that
 * failed; and swapping a fifteen-line code block for a picture is a bigger jump
 * than growing a placeholder.
 *
 * The height is representative, not a reservation: a mermaid drawing's height
 * is unknown until the graph is laid out. What the fixed height buys is that it
 * is not a thin sliver first — a 20px placeholder growing to a 600px sequence
 * diagram moves everything below it much further than a 132px one does. Where
 * the drawing replaces it in place, {@link DrawingReveal} grows the space to
 * the drawing's height instead of changing it in one paint.
 */
export function DrawingSkeleton() {
  return (
    <div
      className="flex flex-col justify-center gap-3"
      style={{ height: DRAWING_SKELETON_HEIGHT }}
      aria-hidden="true"
    >
      <Skeleton className="h-4 w-2/5 rounded-md" />
      <Skeleton className="h-4 w-3/5 rounded-md" />
      <Skeleton className="h-4 w-1/3 rounded-md" />
    </div>
  )
}

/**
 * The skeleton, and the drawing that replaces it, in one frame: the frame the
 * drawing is drawn in, so the material does not change when it lands, only
 * what is in it.
 *
 * A drawing the reader watched arrive (mounted undrawn) grows from the
 * skeleton's height to its own (the deliberate step on the entrance curve)
 * while the skeleton fades out over it and the drawing fades in: the same
 * arrival a card makes into its slot (`CardSlotArrival`). One that mounts
 * drawn, and every one under reduced motion, stands at once.
 *
 * "Its own height" is the drawing's LAID-OUT height, which is not known when
 * it mounts: a view measures its nodes after its first paint and only then
 * lays them out (`GraphCanvas`), so a mindmap measures 184px on the frame it
 * mounts and 222px on the next. Animating to `height: 'auto'` resolved `auto`
 * once, at the start, and the frame then jumped the remaining 38px in one
 * paint as the tween ended, above the line the reader was on. So the target is
 * the drawn content's height as a `ResizeObserver` reports it, once it has
 * stood still for two frames, and every later report retargets the running tween
 * from where the frame is. Only once the frame has reached the content's
 * latest height does it let go to `auto`.
 *
 * Clipped only while it grows, so a drawing wider than the column still
 * scrolls in its frame after. The content sits in its own block formatting
 * context (`flow-root`), so a child's margin is part of the measured height
 * and does not collapse differently once the clip comes off.
 */
export function DrawingReveal({ drawn, children }: { drawn: boolean; children?: ReactNode }) {
  const [arrives] = useState(!drawn)
  const [standing, setStanding] = useState(drawn)
  const deliberate = useMotionToken(motionDeliberateEntrance)
  const transition = arrives ? deliberate : motionInstant
  const contentRef = useRef<HTMLDivElement>(null)
  // The drawn content's laid-out height; `null` until it is first measured.
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const latestHeight = useRef<number | null>(null)
  const grows = drawn && !standing

  // The frame holds the skeleton's height until the drawing's height has stood
  // still for two frames, then grows; once it grows, every later report retargets
  // it at once. The wait is for the view's own layout: before it, the view
  // reports a height it is about to leave (smaller than the skeleton, for a
  // mindmap), and aiming at that made the frame dip 30px and come back up.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!grows || !content) return
    let growing = false
    let frame = 0
    let waited = 0
    const read = () => content.getBoundingClientRect().height
    const aim = (height: number) => {
      latestHeight.current = height
      setContentHeight(height)
    }
    // Two still frames, not one: the view measures its nodes in its own
    // observer, which runs after this frame's callbacks, so one frame could
    // read the height just before the layout lands.
    const settle = (seen: number, still: number) => {
      frame = requestAnimationFrame(() => {
        const now = read()
        const stillNow = now === seen ? still + 1 : 0
        // A drawing that never stands still (one animating itself) is not
        // waited on past a few frames.
        if (stillNow >= 2 || ++waited >= SETTLE_FRAMES_MAX) {
          growing = true
          aim(now)
        } else {
          settle(now, stillNow)
        }
      })
    }
    const report = () => {
      if (growing) return aim(read())
      cancelAnimationFrame(frame)
      settle(read(), 0)
    }
    report()
    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(frame)
    const observer = new ResizeObserver(report)
    observer.observe(content)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [grows])

  const height =
    standing && drawn
      ? 'auto'
      : drawn
        ? (contentHeight ?? DRAWING_SKELETON_HEIGHT)
        : DRAWING_SKELETON_HEIGHT
  return (
    // eslint-disable-next-line grid/motion-vocabulary -- a drawing growing from its skeleton to its own height in place, at or below the reading point; instant under reduced motion
    <motion.div
      className={cn('relative', !(standing && drawn) && 'overflow-hidden')}
      initial={false}
      animate={{ height }}
      // Letting go to `auto` changes no height, so it takes no time.
      transition={standing && drawn ? motionInstant : transition}
      onAnimationComplete={(definition) => {
        if (!drawn) {
          setStanding(false)
          return
        }
        // A tween that ended on a height the content has since left is not
        // the end: the observer has already retargeted the next one.
        const reached = (definition as { height?: unknown }).height
        if (typeof reached === 'number' && reached === latestHeight.current) setStanding(true)
      }}
    >
      {drawn && (
        <motion.div
          ref={contentRef}
          className="flow-root"
          // Under reduced motion no first state at all: an instant tween still
          // paints its starting value for one frame.
          initial={transition === motionInstant ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={transition}
        >
          {children}
        </motion.div>
      )}
      <AnimatePresence initial={false}>
        {!drawn && (
          <motion.div
            key="skeleton"
            className="absolute inset-x-0 top-0"
            exit={{ opacity: 0 }}
            transition={transition}
          >
            <DrawingSkeleton />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/**
 * The line under a drawing (the filing control, the „Schematisch" doctrine)
 * arriving with it rather than in one paint. It mounts when the drawing does,
 * below it, and landed whole it moved everything under the figure by its 44px
 * row in the frame the drawing began to grow, the same jump
 * {@link DrawingReveal} exists to take out. So it grows from nothing on the
 * same deliberate step, fading in.
 *
 * A `figcaption` of its own, not `HeightArrival` around one: a caption is only
 * the figure's caption as the figure's direct child. Use it inside
 * `<AnimatePresence initial={false}>`, so a caption already there when the
 * figure mounted stands at once. Spacing goes in as padding, not margin, so it
 * is inside the animated height instead of landing before it. Clipped only
 * while it grows; instant under reduced motion.
 */
export function DrawingCaption({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const enter = useMotionToken(motionDeliberateEntrance)
  const [growing, setGrowing] = useState(false)
  return (
    // eslint-disable-next-line grid/motion-vocabulary -- a drawing's caption arriving with it, below the drawing; instant under reduced motion
    <motion.figcaption
      className={cn(growing && 'overflow-hidden', className)}
      initial={enter === motionInstant ? false : { height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      transition={enter}
      onAnimationStart={() => setGrowing(true)}
      onAnimationComplete={() => setGrowing(false)}
    >
      {children}
    </motion.figcaption>
  )
}
