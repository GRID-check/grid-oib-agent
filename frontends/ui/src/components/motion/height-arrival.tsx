'use client'

/**
 * A block that ARRIVES below the reading line and takes its height smoothly.
 *
 * The answer's late blocks (the takeaways, an unplaced card, the Projektbezug
 * strip that turned up after the prose began) used to mount with a CSS
 * fade-and-rise while their full height landed in one frame: the rise was
 * 4px, the shove underneath it was the block's whole height. This grows the
 * height from 0 to `auto` on `motionDeliberateEntrance` while the content
 * fades in, so the only thing that moves is what lies below it, and it moves
 * at the same pace as the card slots that open in the prose (`CardSlot`).
 *
 * Use it inside `<AnimatePresence initial={false}>`: a block that was already
 * there when the surface mounted (a stored answer, a reload) stands at once,
 * and only one the reader watches arrive animates. Removing it runs the exit
 * (`motionQuickExit`, accelerating away) before it unmounts.
 *
 * It is clipped only while it animates. Clipped for good, a popover or focus
 * ring inside it would be cut off; never clipped, the content would spill out
 * of a 0px frame. It is a flex column so a child's margin can never collapse
 * through it: margin collapsing depends on overflow, and a margin that stopped
 * collapsing the moment the clip came off would be a 4px jump at the end.
 *
 * Reduced motion gets the end state in one frame (`useMotionToken`): opacity
 * and height are not covered by `<MotionConfig reducedMotion="user">`.
 */

import { useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { motionDeliberateEntrance, motionInstant, motionQuickExit, useMotionToken } from './index'

export const HeightArrival = ({
  children,
  className,
  testId,
}: {
  children: ReactNode
  /** Classes for the frame itself; put spacing here rather than on the child. */
  className?: string
  testId?: string
}) => {
  const enter = useMotionToken(motionDeliberateEntrance)
  const exit = useMotionToken(motionQuickExit)
  const [animating, setAnimating] = useState(false)
  return (
    // eslint-disable-next-line grid/motion-vocabulary -- the shared arrival primitive: a block arriving below the reading point
    <motion.div
      data-testid={testId}
      className={cn('flex flex-col', animating && 'overflow-hidden', className)}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0, transition: exit }}
      transition={enter}
      onAnimationStart={() => setAnimating(true)}
      onAnimationComplete={() => setAnimating(false)}
    >
      {children}
    </motion.div>
  )
}

/**
 * A block that stays MOUNTED and opens or closes its height: 0 while closed,
 * `auto` while open, on `motionDeliberateEntrance` like `HeightArrival`.
 * Height only: the content fades on its own (the answer footer keeps its own
 * opacity transition), and two fades of one block multiply into a slow start.
 *
 * `instant` opens it in one frame, for a block opened where nobody can see it
 * (below the viewport), where an animation would be work for nothing. It
 * mounts in its state without animating (`initial={false}`), and reduced
 * motion gets every change in one frame (`useMotionToken`).
 *
 * Clipped while closed or animating, for the same reasons as above.
 */
export const HeightExpand = ({
  open,
  instant = false,
  children,
  className,
  testId,
}: {
  open: boolean
  instant?: boolean
  children: ReactNode
  className?: string
  testId?: string
}) => {
  const enter = useMotionToken(motionDeliberateEntrance)
  const [animating, setAnimating] = useState(false)
  return (
    // eslint-disable-next-line grid/motion-vocabulary -- the shared arrival primitive: a mounted block opening below the reading point
    <motion.div
      data-testid={testId}
      data-open={open ? 'true' : 'false'}
      className={cn('flex flex-col', (animating || !open) && 'overflow-hidden', className)}
      initial={false}
      animate={{ height: open ? 'auto' : 0 }}
      transition={instant ? motionInstant : enter}
      onAnimationStart={() => setAnimating(true)}
      onAnimationComplete={() => setAnimating(false)}
    >
      {children}
    </motion.div>
  )
}
