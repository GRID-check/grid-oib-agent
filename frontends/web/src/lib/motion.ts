/**
 * The motion tokens, for scripts. The same values are CSS custom properties in
 * `src/styles/global.css` (`--duration-*`, `--ease-*`, `--stagger-*`,
 * `--travel-*`); `scripts/lint-motion.mjs` (part of `npm run check`) fails when
 * the two disagree. What each token is for: `docs/ux/motion.md`.
 *
 * Plain data and pure helpers only: this module is imported by pages that do
 * not load GSAP (the blog), so the GSAP registration lives in
 * `src/scripts/motion-gsap.ts`.
 */

/** Durations in milliseconds. GSAP wants seconds: use `sec()`. */
export const DURATION = {
  /** State feedback: hover, press, a toggle. */
  tick: 120,
  /** Small objects arriving: a chip, a tick mark, a stamp. */
  quick: 200,
  /** One element changing place or size. */
  base: 320,
  /** A line drawn, a sheet laid down, a block arriving. */
  draw: 560,
  /** A composed sequence's longest single move; an ink settling into register. */
  slow: 900,
} as const

/**
 * Easings as cubic-bézier control points. No overshoot anywhere except
 * `press`, which is reserved for an object striking paper (the stamp).
 */
export const EASE = {
  /** A pen across paper: even acceleration and braking. Lines, wipes, camera moves. */
  draft: [0.65, 0, 0.35, 1],
  /** Arrival: moves at once and comes to rest slowly. Entrances, registration. */
  settle: [0.16, 1, 0.3, 1],
  /** Departure: starts slowly, leaves quickly. Only for things going away. */
  lift: [0.7, 0, 0.84, 0],
  /** A sheet slid between two resting places: page changes, panels. */
  sheet: [0.4, 0, 0.1, 1],
  /** The one overshoot: a rubber stamp compressing into the sheet. */
  press: [0.3, 0.7, 0.4, 1.3],
} as const

/** Stagger between siblings, in milliseconds. */
export const STAGGER = {
  /** Items of one row or list. */
  row: 60,
  /** Steps of a sequence the reader is meant to follow in order. */
  step: 120,
  /** Ceiling on a whole stagger: past it, group the items instead. */
  max: 360,
} as const

/** Distances travelled, in CSS px. */
export const TRAVEL = {
  /** Misregistration of an ink pass. */
  hair: 3,
  sm: 8,
  md: 16,
  lg: 32,
} as const

export type Duration = keyof typeof DURATION
export type Ease = keyof typeof EASE

/** A duration in seconds, for GSAP. */
export const sec = (d: Duration) => DURATION[d] / 1000

/** An easing as a CSS / Web Animations timing function. */
export const cssEase = (e: Ease) => `cubic-bezier(${EASE[e].join(', ')})`

/**
 * One stagger for `n` items that never exceeds `STAGGER.max` in total, so a
 * long list arrives as a group rather than a queue.
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
