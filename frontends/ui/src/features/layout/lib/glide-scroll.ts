/**
 * Glide a scroll container to a position on the house glide spring, the way the
 * thread brings a just-sent question to the top.
 *
 * Not `scrollIntoView({ behavior: 'smooth' })`: the browser's smooth scroll has
 * its own duration and curve, cannot be interrupted except by another scroll,
 * and on a long thread crosses thousands of pixels at a speed nobody can read.
 * Here the travel is the spring's (`springGlide`, no visible overshoot at any
 * distance), and a travel longer than one and a half viewports first jumps to
 * half a viewport short of the target and glides the rest: the reader sees
 * the arrival, not a blur of the thread.
 *
 * Interruptible: the reader's own wheel, touch, pointer or key stops it where
 * it is, so a glide never fights a hand. Reduced motion sets the position
 * directly.
 */

import { animate } from 'motion/react'
import { springGlide } from '@/components/motion'

export interface GlideHandle {
  /** Stop the glide where it is (idempotent). */
  stop: () => void
}

const NOOP: GlideHandle = { stop: () => {} }

/** Input that means the reader has taken the scroll over. */
const READER_EVENTS = ['wheel', 'touchstart', 'pointerdown'] as const

export const glideScrollTo = (
  container: HTMLElement,
  top: number,
  { reducedMotion }: { reducedMotion: boolean }
): GlideHandle => {
  const max = Math.max(0, container.scrollHeight - container.clientHeight)
  const to = Math.min(max, Math.max(0, top))
  const from = container.scrollTop
  if (reducedMotion || Math.abs(to - from) < 1) {
    container.scrollTop = to
    return NOOP
  }

  let start = from
  const viewport = container.clientHeight
  if (Math.abs(to - from) > 1.5 * viewport) {
    start = to - Math.sign(to - from) * (viewport / 2)
    container.scrollTop = start
  }

  let stopped = false
  const controls = animate(start, to, {
    ...springGlide,
    onUpdate: (value) => {
      container.scrollTop = value
    },
  })
  const detach = () => {
    for (const type of READER_EVENTS) container.removeEventListener(type, stop)
    window.removeEventListener('keydown', stop)
  }
  function stop() {
    if (stopped) return
    stopped = true
    controls.stop()
    detach()
  }
  for (const type of READER_EVENTS) container.addEventListener(type, stop, { passive: true })
  window.addEventListener('keydown', stop)
  void controls.then(detach, detach)
  return { stop }
}
