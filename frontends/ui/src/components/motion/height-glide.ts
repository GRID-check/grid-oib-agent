'use client'

/**
 * A frame whose content was SWAPPED in place glides to its new height instead
 * of landing on it in one frame.
 *
 * The narrow case the design language allows a height tween in, besides a
 * block arriving below the reading point (`HeightArrival`): one content
 * replacing another in the same frame, where the reader is looking. Mostly a
 * change the reader just asked for: a proposal card answered „Ja" folding
 * from its question to its one-line receipt, a tab strip switching to a
 * shorter panel. Landed in one frame, everything under the card jumped by the
 * difference at the exact moment the reader's eye was on the button they had
 * pressed; glided, the change reads as the consequence of the press. The
 * system may swap a frame's content too, and then the same glide applies: a
 * diagram fence that fails to draw gives way to its source inside the
 * figure's frame (`mermaid-diagram.tsx`), and the frame glides between the
 * two heights while one fades out and the other in.
 *
 * Keyed, not continuous: the frame animates only when `swapKey` changes. Any
 * other size change (an error line, a fetched column, a window resize) still
 * lands at once, because it is not a swap of one content for another and a
 * lagging frame there reads as the page catching up.
 *
 * Run imperatively, in the layout effect of the commit that swapped the
 * content, so the first painted frame is already the OLD height: a
 * `ResizeObserver` keeps the last settled height, and it reports after layout
 * effects run, so at that point it still holds the height before the swap.
 * Clipped only while gliding, so a focus ring is not cut off at rest. Reduced
 * motion gets the end state in the same frame (`useMotionToken`).
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { animate, type AnimationPlaybackControls } from 'motion/react'
import { motionBase, motionInstant, useMotionToken } from './index'

export function useHeightGlide(frameRef: RefObject<HTMLElement | null>, swapKey: unknown): void {
  const transition = useMotionToken(motionBase)
  const settledHeight = useRef<number | null>(null)
  const previousKey = useRef(swapKey)
  const running = useRef<AnimationPlaybackControls | null>(null)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') return
    settledHeight.current = frame.offsetHeight
    const observer = new ResizeObserver(() => {
      if (!running.current) settledHeight.current = frame.offsetHeight
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [frameRef])

  useLayoutEffect(() => {
    if (Object.is(previousKey.current, swapKey)) return
    previousKey.current = swapKey
    const frame = frameRef.current
    if (!frame) return

    // A swap during a glide starts from where the frame IS, not from where the
    // last glide began, so a quick double change does not snap back first.
    const from = running.current ? frame.getBoundingClientRect().height : settledHeight.current
    running.current?.stop()
    running.current = null
    frame.style.height = ''
    const to = frame.offsetHeight

    if (from === null || Math.abs(from - to) < 1 || transition === motionInstant) {
      frame.style.overflow = ''
      settledHeight.current = to
      return
    }

    frame.style.overflow = 'hidden'
    // Pinned here, not left to the first keyframe: `animate` writes that on
    // motion's next frameloop tick, and a frame painted before it showed the
    // NEW height for one paint and then sprang back to the old one.
    frame.style.height = `${from}px`
    const controls = animate(frame, { height: [`${from}px`, `${to}px`] }, transition)
    running.current = controls
    void controls.then(() => {
      if (running.current !== controls) return
      running.current = null
      frame.style.height = ''
      frame.style.overflow = ''
      settledHeight.current = frame.offsetHeight
    })
  }, [swapKey, frameRef, transition])

  useEffect(() => () => running.current?.stop(), [])
}
