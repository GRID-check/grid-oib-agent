/**
 * A streamed answer's text, shown at a steady pace a little behind what has
 * arrived. The rules are in `../lib/stream-pace.ts`; this is only the clock.
 *
 * The clock runs only while a streaming answer has something held back, and
 * steps every `PACE_TICK_MS`, not every frame: each step re-parses the answer
 * as Markdown, and a phone pays for that per step. A finished answer is shown
 * whole: the terminal is never paced.
 *
 * Off under vitest (like the store's delta batching), so a spec that renders a
 * streaming answer sees its text at once; the pace has specs of its own.
 */

import { useEffect, useRef, useState } from 'react'
import {
  PACE_TICK_MS,
  advancePace,
  initialPace,
  keepThroughRewrite,
  noteArrival,
  type PaceState,
} from '../lib/stream-pace'

const PACING_BY_DEFAULT = process.env.NODE_ENV !== 'test'

export function usePacedText(text: string, streaming: boolean, enabled = PACING_BY_DEFAULT): string {
  // An answer that mounts finished is shown whole; one that mounts streaming
  // starts from nothing and is paced from its first word.
  const startAt = enabled && streaming ? 0 : text.length
  const [shown, setShown] = useState(startAt)
  const pace = useRef<PaceState>(initialPace(startAt))
  const lastText = useRef(text)
  const latest = useRef(text)

  useEffect(() => {
    latest.current = text
  })

  // An arrival, or a replacement. A snapshot that rewrites text already shown
  // keeps the shown length (moved on to a clean cut) and paces only what lies
  // beyond it; it never takes shown text back to type it out again.
  useEffect(() => {
    const previous = lastText.current
    lastText.current = text
    let next = pace.current
    if (!text.startsWith(previous.slice(0, next.shown))) next = initialPace(keepThroughRewrite(text, next.shown))
    next = noteArrival(next, text.length, performance.now())
    pace.current = next
    setShown(next.shown)
  }, [text])

  // The turn has ended: everything is shown, so a later stream starts level.
  useEffect(() => {
    if (streaming) return
    pace.current = initialPace(text.length)
    setShown(text.length)
  }, [streaming, text])

  const behind = enabled && streaming && shown < text.length
  useEffect(() => {
    if (!behind) return
    let last = performance.now()
    const id = window.setInterval(() => {
      const now = performance.now()
      const next = advancePace(pace.current, latest.current, now - last, now)
      last = now
      pace.current = next
      setShown(next.shown)
    }, PACE_TICK_MS)
    return () => window.clearInterval(id)
  }, [behind])

  if (!enabled || !streaming) return text
  return text.slice(0, Math.min(shown, text.length))
}
