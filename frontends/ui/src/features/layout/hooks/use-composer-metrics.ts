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
 * `ChatArea` reserves exactly this much bottom padding under the transcript,
 * instead of the fixed guess it used to make, so the last message clears the
 * input by a known gap and no more.
 *
 * `--welcome-offset` — how much room the EMPTY canvas's greeting has to leave
 * below itself: the composer's height, plus how far the composer is lifted off
 * the floor, plus a gap. The greeting bottom-aligns against it and therefore
 * sits exactly one gap above the input, by construction rather than by
 * arithmetic. An earlier version centred the greeting and computed the
 * clearance instead; the sum silently omitted the column's own `pt-20` and the
 * composer landed on the greeting on a phone. Geometry that cannot overlap
 * beats geometry that is calculated not to.
 *
 * ── The lift ────────────────────────────────────────────────────────────────
 *
 * How far the composer sits above the bottom of the column is zero for a thread
 * with messages in it: a transcript wants every pixel, and an input floating in
 * the middle of a conversation is a stranded control. On the empty canvas the
 * opposite is true — there is no transcript to give the height to, and pinning
 * the input to the floor while the greeting floats near the top leaves the
 * reader's eye jumping between two far-apart things. Lifting it puts the
 * greeting and the input in the middle of the column as one group.
 *
 * The lift is half the leftover height: `(H − composerH − gap − greetingH) / 2`
 * puts the greeting and the composer either side of the column's centre.
 * `GREETING_H_PX` is an estimate of the hero line, and it is allowed to be
 * wrong: it can only put the pair a few pixels off centre, never on top of each
 * other, because of how `--welcome-offset` is built.
 *
 * ── Why the lift is a NUMBER and not a calc() ────────────────────────────────
 *
 * It used to be `max(0px, calc((100dvh − …) / 2))`, resolved by the engine and
 * written straight onto the composer's `bottom`. Two things were wrong with
 * that, and the second is the one a reader could see:
 *
 *   · `100dvh` is the viewport, and the lift is measured inside the chat
 *     COLUMN. Anything above the column — a route with a top bar, the mobile
 *     browser's own chrome — made the leftover too big and pushed the pair off
 *     centre. `H` is now the column's own client height, from the same
 *     ResizeObserver that already measures the composer.
 *   · a value only CSS knows cannot be animated by anything else. Sending the
 *     first message flips this hook's one input, and the composer teleported
 *     from the middle of the column to the floor between two frames. Travel is
 *     what tells the reader that the input they were typing in and the input
 *     now under the transcript are the same object; a jump makes them two.
 *
 * So the lift resolves to px here, and `MainLayout` hands it to motion.dev as a
 * transform. It is rounded to whole pixels, because a resting transform on a
 * fractional offset renders soft text.
 */

import { useCallback, useRef, useState, type CSSProperties } from 'react'
import type { Transition } from 'motion/react'
import { springGlide } from '@/components/motion'

/**
 * Breathing room between the composer and the greeting above it.
 *
 * It is folded into `--welcome-offset` rather than published on its own. The
 * gap and the lift used to be two variables the welcome column added up in a
 * `calc()`, which meant the greeting's resting place was recomputed from three
 * live numbers — and all three change at the exact moment the greeting starts
 * to leave (see the freeze below).
 */
const COMPOSER_GAP_PX = 32

/** The hero greeting line — the whole of the welcome column above the input. */
const GREETING_H_PX = 28

/**
 * Room left under the greeting before anything has been measured, and in jsdom,
 * where every box is 0. The composer half matches the `pb-44` this replaced.
 */
export const WELCOME_OFFSET_FALLBACK = '13rem'

export interface ComposerMetrics {
  /**
   * Attach to the floating composer stack — this is the element measured.
   *
   * A callback ref, not a `useRef` box read from a mount effect. The box was
   * empty whenever the composer mounted later than its column — the `/dev`
   * preview seeds its fixture in an effect and renders nothing on the first
   * pass — and a mount effect with no dependencies never looks again. Nothing
   * broke loudly: the measurement simply never happened and every consumer
   * silently used its fallback, which is the failure mode a measurement has to
   * be built against. A callback ref runs when the node actually arrives.
   */
  composerRef: (node: HTMLDivElement | null) => void
  /** Spread onto the chat column: publishes the variables to its descendants. */
  columnVars: CSSProperties
  /** Spread onto the floating composer stack: pins its box to the floor. */
  composerStyle: CSSProperties
  /**
   * Spread onto the floating composer stack (a `motion.div`). Places it at the
   * lift, and travels there only when the travel is real.
   *
   * One object rather than three props, because the three only work together
   * and the `/dev` preview has to wire them the same way the product does. What
   * it encodes:
   *
   *   · the lift is a TRANSFORM, so the descent costs no layout;
   *   · `initial={false}` — the composer is placed on mount, never animated in;
   *   · the spring runs ONLY across a change of emptiness. Every other reason
   *     the lift moves is arithmetic, not a journey: the composer measuring 0px
   *     for a frame before its own content mounts (this drifted the composer
   *     down half the screen on every new chat, which is how the rule was
   *     found), a banner appearing, a window resize. Those are applied in one
   *     frame. Animating them claims a movement that did not happen.
   */
  composerMotion: {
    initial: false
    animate: { y: number }
    transition: Transition
    onAnimationComplete: () => void
  }
}

/**
 * @param isThreadEmpty Whether the thread has no messages yet — the only input,
 *   because it is the only thing that decides whether the composer is furniture
 *   at the bottom of a transcript or half of the empty canvas.
 */
export function useComposerMetrics(isThreadEmpty: boolean): ComposerMetrics {
  const [composerHeight, setComposerHeight] = useState<number | null>(null)
  const [columnHeight, setColumnHeight] = useState<number | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  // Measured in the ref callback, which React runs during the commit — before
  // paint, like a layout effect, so the transcript never paints once with the
  // wrong padding and jumps.
  //
  // Two elements, one observer: the composer (its own height) and the column it
  // floats in (the height the lift is a fraction of). The column is the
  // composer's offsetParent by construction — the stack is `absolute` and the
  // column is the nearest positioned ancestor — so nothing has to be threaded
  // in for this, and a preview that reproduces the column gets it for free.
  const composerRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return
    const column = node.offsetParent
    const update = () => {
      setComposerHeight(node.offsetHeight)
      if (column) setColumnHeight(column.clientHeight)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(node)
    if (column) ro.observe(column)
    observerRef.current = ro
  }, [])

  const measured = composerHeight != null && columnHeight != null

  // `Math.max(0, …)` is the short-viewport guard: on a phone in landscape the
  // leftover goes negative, and a negative lift would push the composer off the
  // bottom of the column rather than simply not lifting it.
  const restLift = measured
    ? Math.max(0, Math.round((columnHeight - composerHeight - COMPOSER_GAP_PX - GREETING_H_PX) / 2))
    : 0
  const composerLift = isThreadEmpty ? restLift : 0

  // The greeting's resting place, FROZEN the moment the thread stops being
  // empty. Both numbers it is built from change in that same tick — the lift
  // goes to zero, and the composer shrinks as the sent text leaves the textarea
  // — while the greeting is still on screen, fading out. Live values would drop
  // it half a screen in the first frame of its own exit, which is the one frame
  // the reader is certainly looking at it.
  const welcomeOffsetRef = useRef<number | null>(null)
  if (isThreadEmpty && measured) {
    welcomeOffsetRef.current = composerHeight + restLift + COMPOSER_GAP_PX
  }
  const welcomeOffset = welcomeOffsetRef.current

  // Is this render the one where the thread stopped (or started) being empty?
  //
  // Compared and updated DURING the render, not from an effect: the new lift
  // and the transition that carries it have to reach motion.dev in the same
  // commit. An effect lands one commit late, by which time the animation has
  // already started under whichever transition was there before.
  const [wasEmpty, setWasEmpty] = useState(isThreadEmpty)
  const [travelling, setTravelling] = useState(false)
  if (wasEmpty !== isThreadEmpty) {
    setWasEmpty(isThreadEmpty)
    setTravelling(true)
  }

  return {
    composerRef,
    composerMotion: {
      initial: false as const,
      // `composerLift === 0 ? 0 : …` rather than a bare negation: `-0` is what
      // negating a zero lift produces, and it is a different value to `0` under
      // `Object.is` — so the floor would be reachable as two values, and any
      // consumer comparing against one of them would be wrong half the time.
      animate: { y: composerLift === 0 ? 0 : -composerLift },
      transition: travelling ? springGlide : { duration: 0 },
      // Released on arrival rather than after a guessed delay, so a measurement
      // landing a moment after the journey ends is applied instantly again.
      onAnimationComplete: () => setTravelling(false),
    },
    columnVars: {
      // Both undefined until measured, so the CSS fallbacks cover that frame.
      ...(composerHeight != null ? { ['--composer-h' as string]: `${composerHeight}px` } : {}),
      ...(welcomeOffset != null ? { ['--welcome-offset' as string]: `${welcomeOffset}px` } : {}),
    },
    // The lift is a transform now (see the header), so the box itself stays on
    // the floor: `bottom: 0` and nothing else.
    composerStyle: { bottom: 0 },
  }
}
