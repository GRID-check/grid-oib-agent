/**
 * The drawing layer — scale mapping and the crisp SVG measurement primitives.
 *
 * Split out of `kit.tsx` (`docs/design/grid-card-charter.md` §A7). Everything
 * here belongs to the fifteen schematics and to nothing else: importing this
 * module is the declaration that a card DRAWS.
 *
 * Design contract:
 * - Geometry is drawn TO SCALE (metres/centimetres → SVG units via
 *   {@link fitScale}), sketched with seeded rough.js strokes (see rough.tsx).
 * - The measurement layer on top of it is CRISP: {@link DimensionArrow},
 *   {@link ExtensionLine} and {@link SvgLabel} use thin precise lines and a
 *   text halo in the card colour. Object geometry is sketched because it is
 *   approximated; a dimension is not, and drawing it wobbly would claim a
 *   precision the number does not have — in the other direction.
 */

'use client'

import { type FC, type ReactNode } from 'react'
// The status vocabulary lives in the shell, and a dimension arrow legitimately
// reaches for it: an arrow is coloured by the verdict on the dimension it
// measures. The §A7 split is about `rough`, not about words — nothing here
// may sketch, and everything here may name a status.
import { statusColor } from '../cards/shell'
import type { DimStatus } from './types'

/* ── scale mapping ────────────────────────────────────────────────────────── */

/**
 * Uniform real-world → SVG scale factor: fits `realW × realH` (metres or
 * centimetres) into `boxW × boxH` SVG units, preserving aspect ratio.
 */
export const fitScale = (realW: number, realH: number, boxW: number, boxH: number): number =>
  Math.min(boxW / Math.max(realW, 1e-6), boxH / Math.max(realH, 1e-6))

/* ── crisp SVG measurement layer ──────────────────────────────────────────── */

interface SvgLabelProps {
  x: number
  y: number
  children: ReactNode
  anchor?: 'start' | 'middle' | 'end'
  fill?: string
  size?: number
  mono?: boolean
  italic?: boolean
  weight?: number
  transform?: string
  /** Halo colour behind the glyphs; defaults to the card surface. */
  halo?: string
}

/** SVG text with a halo in the card colour so labels stay legible over strokes. */
export const SvgLabel: FC<SvgLabelProps> = ({
  x,
  y,
  children,
  anchor = 'start',
  fill = 'var(--muted-foreground)',
  size = 10,
  mono = false,
  italic = false,
  weight = 500,
  transform,
  halo = 'var(--card)',
}) => (
  <text
    x={x}
    y={y}
    textAnchor={anchor}
    dominantBaseline="central"
    fontSize={size}
    fontWeight={weight}
    fontStyle={italic ? 'italic' : undefined}
    fontFamily={mono ? 'var(--font-mono)' : 'var(--font-sans)'}
    fill={fill}
    stroke={halo}
    strokeWidth={3}
    strokeLinejoin="round"
    transform={transform}
    style={{ paintOrder: 'stroke' }}
  >
    {children}
  </text>
)

interface ExtensionLineProps {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Thin extension line from the measured geometry out to a dimension line. */
export const ExtensionLine: FC<ExtensionLineProps> = ({ x1, y1, x2, y2 }) => (
  <line
    x1={x1}
    y1={y1}
    x2={x2}
    y2={y2}
    stroke="var(--muted-foreground)"
    strokeWidth={0.7}
    opacity={0.55}
  />
)

interface DimensionArrowProps {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Pre-formatted label ("120 cm" or the missing-value phrase). */
  label: string
  status?: DimStatus | null
  /** Explicit colour override (neutral dimensions without a check). */
  color?: string
  /** Perpendicular label offset in px; sign flips the side. Default −9. */
  labelOffset?: number
  fontSize?: number
  dashed?: boolean
  /** Keep the label horizontal even on a vertical dimension (e.g. the long missing-value phrase). */
  horizontalLabel?: boolean
}

/**
 * A dimension line with inward arrowheads and a label at the midpoint, placed
 * where the dimension is actually measured. Vertical dimensions get rotated
 * labels, `needs_input` dimensions render dashed + muted + italic.
 */
export const DimensionArrow: FC<DimensionArrowProps> = ({
  x1,
  y1,
  x2,
  y2,
  label,
  status,
  color,
  labelOffset = -9,
  fontSize = 10,
  dashed,
  horizontalLabel,
}) => {
  const stroke = color ?? (status ? statusColor(status) : 'var(--foreground)')
  const missing = status === 'needs_input'
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const nx = -uy
  const ny = ux
  const ah = 5.5

  const head = (px: number, py: number, dirX: number, dirY: number): string => {
    const bx = px + dirX * ah
    const by = py + dirY * ah
    const wing = ah * 0.5
    return `M ${bx + nx * wing} ${by + ny * wing} L ${px} ${py} L ${bx - nx * wing} ${by - ny * wing}`
  }

  const mx = (x1 + x2) / 2 + nx * labelOffset
  const my = (y1 + y2) / 2 + ny * labelOffset
  const vertical = Math.abs(ux) < 0.35 && !horizontalLabel
  const transform = vertical ? `rotate(-90 ${mx} ${my})` : undefined

  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={stroke}
        strokeWidth={1.1}
        strokeDasharray={dashed || missing ? '4 3' : undefined}
      />
      <path
        d={head(x1, y1, ux, uy)}
        stroke={stroke}
        strokeWidth={1.1}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={head(x2, y2, -ux, -uy)}
        stroke={stroke}
        strokeWidth={1.1}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <SvgLabel
        x={mx}
        y={my}
        anchor="middle"
        fill={stroke}
        size={fontSize}
        mono={!missing}
        italic={missing}
        weight={600}
        transform={transform}
      >
        {label}
      </SvgLabel>
    </g>
  )
}

/* ── canvas wrapper ───────────────────────────────────────────────────────── */

/**
 * Largest allowed blow-up of a drawing: rendered pixels per viewBox unit.
 *
 * Every template is authored in units that behave like pixels — an 8-unit
 * eyebrow, a 9.5-unit dimension label, a 1.1-unit dimension line — so a
 * drawing is in proportion when one unit renders at roughly one pixel. The
 * templates that read correctly in the wide column already sit just above
 * that (building section 1.24, stair 1.19, ramp 1.35, guardrail 1.36); the
 * ones that read as a wall of picture were being stretched two and three
 * times over (door 2.97, turning circle 2.26) purely because they are narrow
 * drawings inside a wide card, and `width: 100%` asked them to fill it. The
 * cap is set just above the widest scale any drawing that looked right was
 * already using, so those are untouched and the rest stop growing past the
 * proportion they were drawn at.
 */
const MAX_CANVAS_SCALE = 1.4

interface SchematicCanvasProps {
  viewW: number
  viewH: number
  label: string
  children: ReactNode
}

/**
 * Responsive SVG stage.
 *
 * The drawing always fits the card: it scales down with the column and is
 * never given a pixel floor that would push it past the card edge, because a
 * schematic that overflows is not scrolled to on a phone — it is read as if
 * the missing part were not there, and the part that goes missing is the
 * right-hand gutter where a dimension arrow and its number live. Scaling up
 * is capped at `MAX_CANVAS_SCALE` so a narrow drawing in a wide column keeps
 * its authored proportion instead of becoming the tallest thing on screen.
 * The scale is uniform in both axes, so no ratio the drawing asserts changes.
 */
export const SchematicCanvas: FC<SchematicCanvasProps> = ({ viewW, viewH, label, children }) => (
  <svg
    viewBox={`0 0 ${viewW} ${viewH}`}
    preserveAspectRatio="xMidYMid meet"
    role="img"
    aria-label={label}
    className="block h-auto w-full"
    style={{ maxWidth: Math.round(viewW * MAX_CANVAS_SCALE) }}
  >
    {children}
  </svg>
)
