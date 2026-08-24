/**
 * Overlay motion — the arrive/leave pair, written once.
 *
 * Six Radix-driven surfaces (`Dialog`, `Popover`, `DropdownMenu`, `Select`,
 * `Tooltip`, `Sheet`) all open and close the same way: a `data-[state]` flip
 * that tw-animate-css turns into `animate-in` / `animate-out` keyframes. Left to
 * themselves each one picked its own timing — the dialog ran a bare
 * `duration-200 ease-out`, and the other five ran tw-animate-css's default
 * `.15s ease`, which is CSS's ease-IN ramp on an ARRIVING surface. So the app
 * had three different opening speeds and nine primitives with no reduced-motion
 * escape hatch at all.
 *
 * Two rules from the design language's Motion vocabulary do all the work here:
 *
 *  - **Anything that MOVES on arrival takes `--ease-entrance`.** These surfaces
 *    zoom and slide in from their trigger, so they arrive; a decision belongs at
 *    the START of that move, not at the end.
 *  - **Exits run one step shorter than their entrance.** 240 → 180ms, on
 *    `--ease-exit`, which accelerates away. Nobody wants to watch a thing they
 *    just dismissed, and a dismissal that lingers as long as the opening reads
 *    as the app not believing the click.
 *
 * These are ANIMATION properties, not transitions, so the reduced-motion escape
 * is `motion-reduce:animate-none` rather than `motion-reduce:transition-none`.
 * The global `prefers-reduced-motion` block in `globals.css` already clamps the
 * duration to 0.01ms; this removes the keyframes outright, which is what keeps a
 * `fill-mode: backwards` entrance from holding its element at `opacity: 0`.
 */

/** Arriving: 240ms on the entrance curve. */
export const OVERLAY_ENTER =
  'data-[state=open]:duration-base data-[state=open]:ease-entrance'

/** Leaving: one step shorter, on the departure curve. */
export const OVERLAY_EXIT = 'data-[state=closed]:duration-quick data-[state=closed]:ease-exit'

/**
 * The reduced-motion escape. Separate from the two above because `Tooltip`
 * animates in without a `data-[state=open]` gate and so composes the enter half
 * differently, and because a future surface may legitimately want one and not
 * the other — but never none.
 */
export const OVERLAY_REDUCED = 'motion-reduce:animate-none'

/** The whole pair plus the escape: what five of the six primitives want. */
export const OVERLAY_MOTION = `${OVERLAY_ENTER} ${OVERLAY_EXIT} ${OVERLAY_REDUCED}`
