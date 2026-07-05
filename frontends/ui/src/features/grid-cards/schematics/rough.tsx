/**
 * Seeded rough.js helpers — the hand-sketched stroke of the schematic kit.
 *
 * Object geometry (walls, storeys, stairs, parcels) is drawn with a subtle
 * rough stroke so the diagrams read as "generated schematic", not a certified
 * CAD drawing; the measurement layer (dimension arrows, marker lines, text)
 * stays crisp for contrast and legibility.
 *
 * SSR safety: only `rough.generator()` is used — pure path-data computation
 * with no canvas/DOM access — so the exact same markup renders on the server
 * and the client. Every shape takes a string seed hashed to a deterministic
 * rough.js seed, so strokes never jitter across re-renders or hydration.
 */

import { type ReactNode } from 'react'
import rough from 'roughjs'

const generator = rough.generator()

export type RoughOptions = NonNullable<Parameters<typeof generator.rectangle>[4]>
type Drawable = ReturnType<typeof generator.rectangle>
export type Point = [number, number]

/** djb2 string hash → positive rough.js seed (0 would mean "random"). */
export const hashSeed = (input: string): number => {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i)
  }
  return (hash >>> 0) % 2147483646 || 1
}

/** Quiet default sketchiness — visible on close look, never wobbly. */
const BASE: RoughOptions = {
  roughness: 0.8,
  bowing: 0.6,
  strokeWidth: 1.3,
  stroke: 'var(--foreground)',
}

const toNodes = (drawable: Drawable): ReactNode => (
  <g>
    {generator.toPaths(drawable).map((p, i) => (
      <path
        key={i}
        d={p.d}
        stroke={p.stroke}
        strokeWidth={p.strokeWidth}
        fill={p.fill ?? 'none'}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ))}
  </g>
)

const opts = (seed: string, overrides?: RoughOptions): RoughOptions => ({
  ...BASE,
  seed: hashSeed(seed),
  ...overrides,
})

export const sketchRect = (
  x: number,
  y: number,
  w: number,
  h: number,
  seed: string,
  overrides?: RoughOptions
): ReactNode => toNodes(generator.rectangle(x, y, w, h, opts(seed, overrides)))

export const sketchLine = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  seed: string,
  overrides?: RoughOptions
): ReactNode => toNodes(generator.line(x1, y1, x2, y2, opts(seed, overrides)))

export const sketchCircle = (
  cx: number,
  cy: number,
  diameter: number,
  seed: string,
  overrides?: RoughOptions
): ReactNode => toNodes(generator.circle(cx, cy, diameter, opts(seed, overrides)))

export const sketchPolygon = (
  points: Point[],
  seed: string,
  overrides?: RoughOptions
): ReactNode => toNodes(generator.polygon(points, opts(seed, overrides)))

/** Open polyline (no closing segment). */
export const sketchPath = (points: Point[], seed: string, overrides?: RoughOptions): ReactNode =>
  toNodes(generator.linearPath(points, opts(seed, overrides)))
