/**
 * GRID motion kit — shared micro-interaction primitives built on motion.dev.
 *
 * One vocabulary of movement for the whole app: quiet fades with a small
 * vertical settle, physical springs for anything the user touches, and
 * staggered reveals for lists. Global reduced-motion handling lives in
 * providers.tsx via <MotionConfig reducedMotion="user">.
 *
 * Prefer these wrappers over ad-hoc `motion.div`s so timing stays consistent.
 */

'use client'

import { type ReactNode } from 'react'
import { motion, type HTMLMotionProps, type Transition, type Variants } from 'motion/react'

/** Physical spring for touchable things (buttons, cards, toggles). */
export const springSnappy: Transition = { type: 'spring', stiffness: 500, damping: 32, mass: 0.6 }

/** Softer spring for larger surfaces (panels, cards settling into place). */
export const springGentle: Transition = { type: 'spring', stiffness: 260, damping: 28 }

/** Quiet tween for opacity-only moves. */
export const easeQuiet: Transition = { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }

/** Variants for a fade with a small vertical settle. */
export const fadeRise: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
}

/** Parent variants that stagger `fadeRise` children. */
export const staggerParent: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } },
}

interface FadeInProps extends HTMLMotionProps<'div'> {
  children?: ReactNode
  /** Seconds to hold before animating in. */
  delay?: number
  /** Vertical settle distance in px (0 for pure fade). */
  distance?: number
}

/** Fade + settle on mount. The default entrance for any newly visible surface. */
export const FadeIn = ({ children, delay = 0, distance = 8, ...props }: FadeInProps): ReactNode => (
  <motion.div
    initial={{ opacity: 0, y: distance }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ ...springGentle, delay }}
    {...props}
  >
    {children}
  </motion.div>
)

interface StaggerProps extends HTMLMotionProps<'div'> {
  children?: ReactNode
  /** Animate when scrolled into view instead of on mount. */
  inView?: boolean
}

/** Container that staggers its <StaggerItem> children. */
export const Stagger = ({ children, inView = false, ...props }: StaggerProps): ReactNode => (
  <motion.div
    variants={staggerParent}
    initial="hidden"
    {...(inView
      ? { whileInView: 'visible', viewport: { once: true, margin: '-64px' } }
      : { animate: 'visible' })}
    {...props}
  >
    {children}
  </motion.div>
)

/** Child of <Stagger>: fades and settles in sequence. */
export const StaggerItem = ({ children, ...props }: HTMLMotionProps<'div'>): ReactNode => (
  <motion.div variants={fadeRise} transition={springGentle} {...props}>
    {children}
  </motion.div>
)

/** Re-export for components that need bespoke micro-interactions. */
export { motion, AnimatePresence } from 'motion/react'
