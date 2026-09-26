/**
 * The motion tokens, for scripts. The same values are CSS custom properties in
 * `src/styles/global.css` (`--duration-*`, `--ease-*`, `--stagger-*`,
 * `--travel-*`); `scripts/lint-motion.mjs` (part of `npm run check`) fails when
 * the two disagree. What each token is for, and the much longer list of what
 * the site does not animate: `docs/ux/motion.md`.
 *
 * The set is small on purpose. A new duration, easing or distance is a change
 * to the motion language, not a local tweak: add it here, in global.css and in
 * the spec, or use one that exists.
 *
 * Plain data and pure helpers only: this module is imported by pages that do
 * not load GSAP (the blog), so the GSAP registration lives in
 * `src/scripts/motion-gsap.ts`.
 */

/** Durations in milliseconds. GSAP wants seconds: use `sec()`. */
export const DURATION = {
  /** State feedback: hover, press, a toggle. */
  tick: 120,
  /** Small things: a menu opening, a tick drawn, a digit turning, a page crossfade. */
  quick: 200,
  /** One element arriving or changing place. */
  base: 320,
  /** The longest single move on the site: a block arriving, an ink settling. */
  slow: 480,
} as const

/**
 * Two easings for the whole site, as cubic-bézier control points. Nothing
 * overshoots, bounces or springs.
 */
export const EASE = {
  /** Arrival: moves at once, comes to rest slowly. Almost everything. */
  settle: [0.16, 1, 0.3, 1],
  /** A pen across paper: even acceleration and braking. Lines being drawn, camera moves. */
  draft: [0.65, 0, 0.35, 1],
} as const

/** Stagger between siblings, in milliseconds. */
export const STAGGER = {
  /** Items of one short list (five at most). */
  row: 60,
  /** Ceiling on a whole stagger: past it, the items arrive as a group. */
  max: 240,
} as const

/** Distances travelled, in CSS px. Nothing on the site moves further by itself. */
export const TRAVEL = {
  /** Misregistration of an ink pass. */
  hair: 3,
  sm: 8,
  md: 16,
} as const

export type Duration = keyof typeof DURATION
export type Ease = keyof typeof EASE

/** A duration in seconds, for GSAP. */
export const sec = (d: Duration) => DURATION[d] / 1000

/** An easing as a CSS / Web Animations timing function. */
export const cssEase = (e: Ease) => `cubic-bezier(${EASE[e].join(', ')})`

/**
 * One stagger for `n` items that never exceeds `STAGGER.max` in total, so a
 * longer list arrives as a group rather than a queue.
 */
export const staggerFor = (n: number, each: number = STAGGER.row) =>
  n <= 1 ? 0 : Math.min(each, STAGGER.max / (n - 1))

/** The media queries every motion script branches on. */
export const MQ = {
  /** Tailwind's `lg`: the staged, full-screen landing page. */
  staged: '(min-width: 1024px)',
  compact: '(max-width: 1023.98px)',
  motion: '(prefers-reduced-motion: no-preference)',
  reduced: '(prefers-reduced-motion: reduce)',
} as const

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia(MQ.reduced).matches
