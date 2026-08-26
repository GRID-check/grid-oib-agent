'use client'

/**
 * The geometry the floating composer and the chat column have to agree on.
 *
 * Two facts travel from the composer to everything drawn around it, and both
 * are published as CSS custom properties on the chat column rather than passed
 * as props: the column is an ancestor, so a variable set there reaches
 * `ChatArea` (and anything it renders) without threading a number through four
 * components that do not otherwise care.
 *
 * `--composer-h` — the measured height of the composer stack (banner + input:
 * variable, because the textarea grows, chips wrap and banners come and go).
 * `ChatArea` reserves exactly this much bottom padding, instead of the fixed
 * guess it used to make, so the last message clears the input by a known gap
 * and no more.
 *
 * `--composer-lift` — how far the composer sits ABOVE the bottom of the column.
 * Zero for a thread with messages in it: a transcript wants every pixel, and an
 * input floating in the middle of a conversation is a stranded control. On the
 * EMPTY canvas the opposite is true — there is no transcript to give the height
 * to, and pinning the input to the floor while the greeting floats near the top
 * leaves the reader's eye jumping between two far-apart things. Lifting it puts
 * the greeting and the input in the middle of the screen as one group.
 *
 * The lift is half the leftover height: `(H − composerH − gap − greetingH) / 2`
 * puts the greeting and the composer either side of the viewport centre.
 *
 * `GREETING_H` is an estimate — the lock chip, its margin and the hero line —
 * and it is deliberately allowed to be wrong. It is wrong by a few pixels and
 * the pair sits a few pixels off centre, which no reader can see. What it must
 * NOT be able to do is push the composer into the greeting, and it cannot:
 * `ChatArea` bottom-aligns the welcome column against `--composer-h` +
 * `--composer-gap`, so the greeting sits exactly one gap above the input
 * whatever this constant says. That is worth stating because the first version
 * of this hook did centre the column and derive the clearance arithmetically —
 * and the arithmetic silently omitted the column's `pt-20` top padding, so the
 * composer overlapped the greeting by 16px on a phone. Geometry that cannot
 * overlap beats geometry that is calculated not to.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

/**
 * Breathing room between the composer and whatever sits above it — the last
 * message of a transcript, or the greeting on the empty canvas. Published as
 * `--composer-gap` rather than repeated at each call site, because it is one
 * half of a pair: `ChatArea` pads by it and this hook lifts by it, and the two
 * drifting apart is exactly how the composer ends up on top of something.
 */
const COMPOSER_GAP = '2rem'

/** Lock chip (1.75rem) + its margin (1rem) + the hero greeting line (~1.75rem). */
const GREETING_H = '4.5rem'

/**
 * Height assumed for the composer before the first measurement lands, and in
 * jsdom, where `offsetHeight` is 0. Matches the `pb-44` this replaced.
 */
export const COMPOSER_H_FALLBACK = '11rem'

export interface ComposerMetrics {
  /** Attach to the floating composer stack — this is the element measured. */
  composerRef: RefObject<HTMLDivElement>
  /** Spread onto the chat column: publishes both variables to its descendants. */
  columnVars: CSSProperties
  /** Spread onto the floating composer stack: places it against the lift. */
  composerStyle: CSSProperties
}

/**
 * @param isThreadEmpty Whether the thread has no messages yet — the only input,
 *   because it is the only thing that decides whether the composer is furniture
 *   at the bottom of a transcript or half of the empty canvas.
 */
export function useComposerMetrics(isThreadEmpty: boolean): ComposerMetrics {
  const composerRef = useRef<HTMLDivElement>(null)
  const [composerHeight, setComposerHeight] = useState<number | null>(null)

  // useLayoutEffect, not useEffect: the padding must be right in the frame the
  // column first paints, or the transcript visibly jumps under the composer.
  useLayoutEffect(() => {
    const el = composerRef.current
    if (!el) return
    const update = () => setComposerHeight(el.offsetHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const composerH = `var(--composer-h, ${COMPOSER_H_FALLBACK})`

  // `max(0px, …)` is the short-viewport guard: on a phone in landscape the
  // leftover goes negative, and a negative lift would push the composer off
  // the bottom of the screen rather than simply not lifting it.
  const lift = isThreadEmpty
    ? `max(0px, calc((100dvh - ${composerH} - ${COMPOSER_GAP} - ${GREETING_H}) / 2))`
    : '0px'

  return {
    composerRef,
    columnVars: {
      // undefined until measured, so `ChatArea`'s fallback covers that frame.
      ...(composerHeight != null
        ? { ['--composer-h' as string]: `${composerHeight}px` }
        : {}),
      ['--composer-gap' as string]: COMPOSER_GAP,
      ['--composer-lift' as string]: lift,
    },
    composerStyle: { bottom: 'var(--composer-lift, 0px)' },
  }
}
