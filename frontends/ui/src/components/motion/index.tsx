/**
 * GRID motion kit — the shared vocabulary of movement, and the only place a
 * timing number should be written in TypeScript.
 *
 * Three ideas, in order of how often you need them:
 *
 *   1. TWEENS (`motionSnap`/`motionQuick`/`motionBase`/`motionEntrance`) for
 *      anything the app does on its own — content arriving, a panel fading, a
 *      row revealing. They mirror the CSS `--motion-*` / `--ease-*` tokens in
 *      styles/tokens.css one for one, so a component that animates in CSS and a
 *      component that animates in JS land on the same numbers.
 *   2. SPRINGS (`springPress`/`springSnap`/`springDrawer`) for anything the
 *      user TOUCHES, plus the two places a small overshoot is the point.
 *   3. WRAPPERS (`FadeIn`, `Stagger`, `StaggerItem`) so the common cases need
 *      no numbers at all.
 *
 * Global reduced-motion handling lives in providers.tsx via
 * <MotionConfig reducedMotion="user">, which zeroes every transition here.
 * CSS-side motion is collapsed by the `prefers-reduced-motion` block in
 * app/globals.css.
 *
 * ── On springs, and why there are now real ones ──────────────────────────────
 *
 * A spring's character is one number: the damping ratio
 *
 *     ζ = damping / (2 · √(stiffness · mass))
 *
 * ζ ≥ 1 is overdamped — it eases to the target and stops, which is a tween
 * wearing a spring's clothes. ζ < 1 overshoots, by
 *
 *     overshoot = e^(−πζ / √(1 − ζ²))
 *
 * of the distance travelled. The two springs this module used to ship were
 * `springSnappy` (ζ = 1.107 — overdamped, 0% overshoot) and `springGentle`
 * (ζ = 0.868 → 0.41%, which on an 8px rise is 0.03px). Both were springs in
 * name only: they paid the spring's cost (an unpredictable, longer settle) and
 * bought none of its character.
 *
 * The design language now permits overshoot where it is purposeful — and
 * budgets it IN PIXELS, not percent, because pixels are what the eye sees.
 * The target is 1–2px of visible overshoot: below ~1px it is invisible and you
 * are paying for nothing, above ~2px it reads as wobble and dense compliance UI
 * cannot afford wobble. That budget is why each spring below carries a TRAVEL
 * RANGE contract, and why the contract is not optional: the same spring is
 * tasteful on a 24px slide and a cartoon on a 200px one.
 */

'use client'

import { type ReactNode } from 'react'
import { motion, type HTMLMotionProps, type Transition, type Variants } from 'motion/react'

/** A cubic-bezier control-point pair, in motion.dev's `ease` tuple form. */
type Bezier = [number, number, number, number]

/**
 * The workhorse curve: decided at the start, settling at the end.
 * Mirrors `--ease-out` (and Tailwind's `ease-out`).
 */
const EASE_OUT: Bezier = [0, 0, 0.2, 1]

/**
 * For things ARRIVING — a longer, softer tail than EASE_OUT.
 * Mirrors `--ease-entrance`.
 *
 * Note the shape: this is an ease-OUT. The curve it replaces, `easeQuiet`, was
 * cubic-bezier(0.25, 0.1, 0.25, 1) — which is CSS's default `ease`, an ease-IN
 * ramp — and it was being used for entrances. An arriving element that starts
 * slowly reads as hesitant; the decision belongs at the beginning of the move.
 */
const EASE_ENTRANCE: Bezier = [0.16, 1, 0.3, 1]

/**
 * A spring, described structurally so its parameters stay readable (and
 * assertable — see index.spec.tsx, which recomputes ζ from these three numbers
 * rather than trusting the comments).
 */
export interface SpringTransition {
  readonly type: 'spring'
  readonly stiffness: number
  readonly damping: number
  readonly mass: number
}

/**
 * PRESS — ζ = 1.00, overshoot 0%. Travel: any (it never overshoots).
 *
 * For press/tap/hold: the scale dip under a finger, a card giving way, a chip
 * depressing. Critically damped ON PURPOSE — not because bounce is forbidden
 * here, but because a press spring's job is INTERRUPTIBILITY, not character.
 * The user releases mid-flight and the spring must reverse from wherever it is,
 * carrying its velocity, without a queued overshoot arriving after the finger
 * has gone. ζ = 1 is the fastest settle with no overshoot at all, which is
 * exactly what a reversible gesture wants.
 *
 * Chosen over a tween because a tween restarts from zero velocity on reverse
 * and visibly stutters; this is the case where a spring earns its keep with no
 * bounce involved.
 */
export const springPress: SpringTransition = {
  type: 'spring',
  stiffness: 600,
  damping: 38,
  mass: 0.6,
}

/**
 * SNAP — ζ = 0.658, overshoot 6.4%. **TRAVEL ≤ 24px ONLY.**
 *
 * The one deliberately playful spring: a small element landing with a tick of
 * life. Toggle knobs, badge counts, an icon swapping, a chip snapping into a
 * row. At the 24px ceiling the overshoot is 1.5px — inside the 1–2px budget and
 * legible as intent. The ceiling is the whole contract: at 100px this same
 * spring overshoots 6.4px, which in a dense list means it visibly barges into
 * the row above. If your element travels further than 24px you want
 * `springDrawer`, not a softer version of this.
 */
export const springSnap: SpringTransition = {
  type: 'spring',
  stiffness: 520,
  damping: 30,
  mass: 1,
}

/**
 * DRAWER — ζ = 0.806, overshoot 1.4%. **TRAVEL ≥ 72px** (large surfaces).
 *
 * Panels, drawers, sheets, cards settling into place — anything whose travel is
 * measured in the size of the surface rather than the size of a control. The
 * small percentage is the point: it is calibrated so that the *pixel* overshoot
 * lands in budget at large travel (1.7px at 120px, 2.0px at 145px), where a 6%
 * spring would throw 7px and read as slapstick. Below ~72px it stops being
 * perceptible at all, and the honest choice there is `motionBase`.
 */
export const springDrawer: SpringTransition = {
  type: 'spring',
  stiffness: 260,
  damping: 26,
  mass: 1,
}

/**
 * CSS `linear()` equivalents of the two overshooting springs, sampled from the
 * same damped-oscillator step response the JS springs solve (24 even samples,
 * run out to where the curve is within 0.2% of its target).
 *
 * These exist for the class-only cases — Radix `data-[state]` transitions,
 * `@utility` blocks, anything driven by a stylesheet rather than by a
 * `motion.div`. Pair each with its `…Duration`; the shape is normalised across
 * whatever duration you give it, but these are the durations at which it settles
 * the way the JS spring does.
 *
 * Browser support: `linear()` is Chrome 113+ / Safari 17.4+ / Firefox 112+. An
 * older engine drops the whole declaration as invalid, so declare a plain
 * `ease-out` timing function BEFORE it and let the cascade upgrade — a spring
 * is a flourish and must degrade to a well-behaved ease, never to `ease`'s
 * default in-ramp by accident.
 */
export const springSnapLinear =
  'linear(0, 0.0723, 0.237, 0.4331, 0.6213, 0.7801, 0.9009, 0.9837, 1.0336, 1.058, 1.0643, 1.0595, 1.0488, 1.0362, 1.0241, 1.0139, 1.0062, 1.001, 0.9978, 0.9963, 0.9959, 0.9962, 0.9969, 0.9977, 1)'

/** Duration at which `springSnapLinear` settles like `springSnap`. */
export const springSnapLinearDuration = '440ms'

export const springDrawerLinear =
  'linear(0, 0.0505, 0.167, 0.3102, 0.4555, 0.5885, 0.7023, 0.7945, 0.866, 0.9191, 0.9568, 0.9822, 0.9984, 1.0077, 1.0123, 1.0138, 1.0134, 1.0119, 1.0099, 1.0079, 1.006, 1.0044, 1.0031, 1.002, 1)'

/** Duration at which `springDrawerLinear` settles like `springDrawer`. */
export const springDrawerLinearDuration = '520ms'

/**
 * The tween scale, one for one with the `--motion-*` CSS tokens.
 *
 * These are the JS half of the same vocabulary: a component that animates in
 * CSS (`duration-base ease-out`) and one that animates through motion.dev
 * should not disagree about how long "the default" is. Three local copies of
 * `{ duration: 0.18, ease: 'easeOut' }` exist elsewhere in the app (ChatArea,
 * ChatToolbar, InboxItemRow) — `motionQuick` is that constant, so they can be
 * imported away.
 */

/** 120ms — a control acknowledging a press. Feedback, not travel. */
export const motionSnap: Transition = { duration: 0.12, ease: EASE_OUT }

/** 180ms — a small local change: chip in, icon swap, row revealing actions. */
export const motionQuick: Transition = { duration: 0.18, ease: EASE_OUT }

/** 240ms — the default. If you are unsure, it is this one. */
export const motionBase: Transition = { duration: 0.24, ease: EASE_OUT }

/** 240ms on the entrance curve — for things ARRIVING (see EASE_ENTRANCE). */
export const motionEntrance: Transition = { duration: 0.24, ease: EASE_ENTRANCE }

/**
 * @deprecated Use `springPress`. Kept so existing call sites keep compiling.
 * The old value (380/32/0.55) was ζ = 1.107 — overdamped, so it was already a
 * tween; `springPress` is the same intent with the settle actually tuned.
 */
export const springSnappy: SpringTransition = springPress

/**
 * @deprecated Use `springDrawer` for large surfaces, or `motionBase` for small
 * ones. The old value (260/28) was ζ = 0.868 → 0.41% overshoot, which on this
 * kit's 8px rise is 0.03px: a spring nobody could see.
 */
export const springGentle: SpringTransition = springDrawer

/**
 * @deprecated Use `motionBase` (or `motionEntrance` for arrivals). The old
 * value was cubic-bezier(0.25, 0.1, 0.25, 1) — CSS's default `ease`, an ease-IN
 * ramp — and it was being used for entrances.
 */
export const easeQuiet: Transition = motionBase

/** Variants for a fade with a small vertical settle. */
export const fadeRise: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
}

/** Seconds between two consecutive `<StaggerItem>`s. */
export const staggerStepSeconds = 0.04

/**
 * How many steps a stagger is allowed to accumulate before it flattens.
 *
 * A stagger is a reading cue — "these arrived together, in this order" — and
 * the cue is spent within the first handful of items. Uncapped, it turns into a
 * queue: this container previously ran 50ms apart with a 50ms lead, so a
 * seven-item list (project settings has one) held its last section back by
 * 350ms. That is a third of a second of a page looking half-loaded, to
 * communicate an ordering nobody was counting.
 *
 * Capping at 5 steps × 40ms puts the whole cascade inside 200ms — under the
 * 240ms base duration, so the stagger finishes arriving before a single item's
 * own animation would have. Items 6, 7, 8… all start together at 200ms.
 */
export const staggerMaxSteps = 5

/**
 * Parent variants that stagger `fadeRise` children, capped.
 *
 * `delayChildren` takes a function in motion 12+ (the older `staggerChildren`
 * multiplies without a ceiling and is deprecated), which is what makes the cap
 * expressible at all. The index is the child's position among the parent's
 * variant children — including grandchildren, since variant context passes
 * through plain elements in between.
 */
export const staggerParent: Variants = {
  hidden: {},
  visible: {
    transition: {
      delayChildren: (index: number) => Math.min(index, staggerMaxSteps) * staggerStepSeconds,
    },
  },
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
    transition={{ ...motionEntrance, delay }}
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

/**
 * Container that staggers its <StaggerItem> children, capped at
 * `staggerMaxSteps` (see above — the cascade is a cue, not a queue).
 */
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
  <motion.div variants={fadeRise} transition={motionEntrance} {...props}>
    {children}
  </motion.div>
)

/** Re-export for components that need bespoke micro-interactions. */
export { motion, AnimatePresence } from 'motion/react'
