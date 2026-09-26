/**
 * How a live Herleitung streams in: what enters, what draws, what nudges, and
 * the one thing that loops.
 *
 * Every rule here is keyed on IDENTITY, never on a mount. React Flow keys a
 * node wrapper and an edge by id, so a component mounts once per id in the
 * normal case, but a flow is free to drop an edge component for a frame (an
 * edge with no position renders nothing) and the column nodes re-pack. The
 * registries below remember which ids already had their entrance, so a
 * remount cannot replay one.
 *
 * - **A node enters once** — fade and a short rise (`--motion-base`,
 *   `--ease-entrance`), CSS, so the global reduced-motion rule reaches it too.
 * - **A connector draws itself once** — a one-shot `stroke-dashoffset` over a
 *   `pathLength` of 1, so the draw does not care how long the path is or
 *   whether the layout moved it mid-draw. It stops: nothing may LOOP on an SVG
 *   path (gotchas: a marching connector cost a phone 245 ms of main thread per
 *   second at rest).
 * - **A node that moves down settles in** — the node jumps to its measured
 *   place (nothing may overlap), and its content is carried the last few
 *   pixels on the transform, never further than the row gap above it.
 * - **The frontier flows** — a dot travels each connector into the newest row:
 *   an HTML element moved by a WAAPI transform/opacity animation, which the
 *   compositor runs. The path is sampled once per shape, not per frame.
 *
 * None of it runs on a settled graph or under `prefers-reduced-motion`: a
 * staged reveal of facts that were true before the reader arrived is theatre.
 */

'use client'

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { motionBase, motionDeliberate, motionEntrance } from '@/components/motion'

/** The node entrance, from the kit (`--motion-base`). */
export const ENTRANCE_MS = Math.round((motionBase.duration as number) * 1000)
/** The connector draw, from the kit (`--motion-deliberate`). */
export const DRAW_MS = Math.round((motionDeliberate.duration as number) * 1000)
/**
 * The furthest a settling node is carried on its transform. Well inside the
 * row gap above it (40px), so the nudge can never lay a node over the row it
 * sits under.
 */
export const NUDGE_MAX_PX = 12
const EASE_ENTRANCE = `cubic-bezier(${(motionEntrance.ease as unknown as readonly number[]).join(', ')})`

export interface ReasoningMotion {
  /** Live turn, motion allowed: new ids enter, draw and flow. */
  enter: boolean
  /** Node ids that have had their entrance (or were on screen without one). */
  entered: Set<string>
  /** Edge ids that have drawn (or were on screen without drawing). */
  drawn: Set<string>
}

const SETTLED: ReasoningMotion = { enter: false, entered: new Set(), drawn: new Set() }

export const ReasoningMotionContext = createContext<ReasoningMotion>(SETTLED)

const REDUCED = '(prefers-reduced-motion: reduce)'

/**
 * Read once, synchronously, when the graph mounts: the entrance is decided on
 * the first render, so a post-mount media hook would already be too late.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED).matches
  )
}

/**
 * Does this id play its entrance? Decided at mount and held, so a later render
 * (a new round, the turn landing) never adds or strips the class mid-flight.
 * `allowed` lets a caller add its own condition, read at mount too.
 */
function useOnce(registry: 'entered' | 'drawn', id: string, allowed: boolean): boolean {
  const motion = useContext(ReasoningMotionContext)
  const [once] = useState(() => allowed && motion.enter && !motion[registry].has(id))
  useLayoutEffect(() => {
    motion[registry].add(id)
  }, [motion, registry, id])
  return once
}

/** A node's entrance: true on the first mount of a new id in a live graph. */
export function useNodeEntrance(id: string, allowed = true): boolean {
  return useOnce('entered', id, allowed)
}

/** A connector's draw: true on the first mount of a new edge id in a live graph. */
export function useEdgeDraw(id: string): boolean {
  return useOnce('drawn', id, true)
}

/**
 * Carry a node that just moved DOWN the last few pixels on its transform.
 *
 * The node is already at its measured place when this runs (React Flow renders
 * the wrapper's position and the node in one commit), so the rows never
 * overlap; only the content is offset, by at most {@link NUDGE_MAX_PX}, and it
 * settles on the entrance curve. Skipped while the node's own entrance runs —
 * both write `transform`, and the later animation would win.
 */
export function useSettleNudge(ref: RefObject<HTMLElement | null>, y: number): void {
  const motion = useContext(ReasoningMotionContext)
  const previous = useRef(y)
  const mountedAt = useRef<number | null>(null)
  useLayoutEffect(() => {
    mountedAt.current = performance.now()
  }, [])
  useLayoutEffect(() => {
    const dy = y - previous.current
    previous.current = y
    const el = ref.current
    if (!motion.enter || !(dy > 0) || !el || typeof el.animate !== 'function') return
    if (mountedAt.current === null || performance.now() - mountedAt.current < ENTRANCE_MS) return
    el.animate(
      [{ transform: `translateY(${-Math.min(dy, NUDGE_MAX_PX)}px)` }, { transform: 'none' }],
      {
        duration: ENTRANCE_MS,
        easing: EASE_ENTRANCE,
      }
    )
  }, [y, motion, ref])
}

let ambientCache = 0

/**
 * `--motion-ambient`, read off the tokens so the loop keeps one truth. Read
 * once: a computed-style read forces a style pass, and the token does not
 * change while the page lives.
 */
function ambientMs(el: Element): number {
  if (ambientCache > 0) return ambientCache
  const raw = getComputedStyle(el).getPropertyValue('--motion-ambient').trim()
  const ms = raw.endsWith('ms') ? parseFloat(raw) : raw.endsWith('s') ? parseFloat(raw) * 1000 : NaN
  ambientCache = Number.isFinite(ms) && ms > 0 ? ms : 0
  return ambientCache
}

/** Sample spacing along a connector, in px: fine enough that a 12px corner stays round. */
const SAMPLE_PX = 6
const MAX_SAMPLES = 64

/**
 * The frontier's one loop: a dot that travels `pathRef`'s connector into the
 * node it feeds, fading in off the source and out under the target.
 *
 * WAAPI on an HTML element, animating `transform` and `opacity` only, so the
 * compositor runs every frame of it. The path is sampled when its shape
 * changes (`d`), never per frame; `delayMs` holds the first lap back while a
 * freshly drawn connector is still drawing. Cancelled on unmount, when the
 * edge stops being the frontier, and when the turn lands.
 */
export function useFlowAlongPath(
  pathRef: RefObject<SVGPathElement | null>,
  dotRef: RefObject<HTMLElement | null>,
  d: string,
  active: boolean,
  delayMs: number
): void {
  useEffect(() => {
    if (!active) return
    let animation: Animation | undefined
    // Sampled on the NEXT frame, not in the commit that changed the shape: a
    // path query forces style and layout, and in the round's own commit that is
    // a second forced layout on the task a phone already feels. A shape that
    // changes again before then (the place pass follows the first measure)
    // cancels this one, so only the settled shape is sampled.
    const frame = requestAnimationFrame(() => {
      const path = pathRef.current
      const dot = dotRef.current
      if (!path || !dot || typeof dot.animate !== 'function' || typeof path.getTotalLength !== 'function') return
      const length = path.getTotalLength()
      const duration = ambientMs(dot)
      if (!(length > 0) || duration === 0) return
      const steps = Math.min(MAX_SAMPLES, Math.max(8, Math.ceil(length / SAMPLE_PX)))
      const keyframes: Keyframe[] = []
      for (let i = 0; i <= steps; i++) {
        const offset = i / steps
        const point = path.getPointAtLength(length * offset)
        keyframes.push({
          offset,
          transform: `translate(${point.x}px, ${point.y}px)`,
          opacity: Math.min(1, offset / 0.15, (1 - offset) / 0.15),
        })
      }
      animation = dot.animate(keyframes, {
        duration,
        delay: delayMs,
        iterations: Infinity,
        // A loop keeps its pace inside its own keyframes (see the motion
        // vocabulary): constant speed along the line reads as flow.
        easing: 'linear',
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      animation?.cancel()
    }
    // `delayMs` only matters for the first lap of a new shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, active, pathRef, dotRef])
}
