/**
 * DimensionDiagramCard — parametric accessibility/geometry schematics.
 *
 * One prebuilt architectural template per `shape` (door elevation, ramp
 * section, corridor plan, turning circle, threshold detail, parking space
 * plan), drawn to scale from the provided dimensions. Each recognised
 * `DimensionCheck` is placed as a status-coloured `DimensionArrow` exactly
 * where it is measured (e.g. the door width between the jambs — lichte
 * Durchgangsbreite, not Stocklichte); every check also appears in the legend
 * below, so nothing provided is ever dropped. Unknown values draw a neutral
 * fallback geometry, but their arrows read "fehlende Angabe".
 */

import { type FC, type ReactNode } from 'react'
import { Ruler } from 'lucide-react'
import {
  DimChecksList,
  DimensionArrow,
  ExtensionLine,
  fitScale,
  fmtDim,
  SchematicCanvas,
  SchematicCard,
  statusColor,
  SvgLabel,
  worstStatus,
} from './kit'
import { sketchCircle, sketchPath, sketchPolygon, sketchRect, type Point } from './rough'
import type { DimensionCheckData, NormReferenceData } from './types'

type Shape = 'door' | 'ramp' | 'corridor' | 'turning_circle' | 'threshold' | 'parking_space'

interface DimensionDiagramCardProps {
  title: string
  shape: Shape
  dimensions: DimensionCheckData[]
  reference?: NormReferenceData | null
  note?: string | null
}

interface Template {
  viewW: number
  viewH: number
  minWidth?: number
  node: ReactNode
}

/** First dimension whose label (or unit) matches one of the keywords. */
const pick = (
  dims: DimensionCheckData[],
  keywords: string[],
  unitIs?: string
): DimensionCheckData | undefined =>
  dims.find((d) => {
    const label = d.label.toLowerCase()
    if (keywords.some((k) => label.includes(k))) return true
    return unitIs != null && (d.unit ?? 'cm') === unitIs
  })

const label = (d: DimensionCheckData): string => fmtDim(d.value, d.unit ?? 'cm')

/** Wall poché: dense hachure fill used for cut walls in plans/sections. */
const POCHE = {
  fill: 'color-mix(in oklch, var(--foreground) 55%, transparent)',
  fillStyle: 'hachure' as const,
  fillWeight: 0.7,
  hachureGap: 5,
  strokeWidth: 1.1,
}

const HATCH_LIGHT = {
  fill: 'color-mix(in oklch, var(--muted-foreground) 45%, transparent)',
  fillStyle: 'hachure' as const,
  fillWeight: 0.5,
  hachureGap: 9,
}

/* ── door: front elevation, frame + leaf + handle ─────────────────────────── */

const doorTemplate = (dims: DimensionCheckData[]): Template => {
  const widthDim = pick(dims, ['breite', 'durchgang', 'width'])
  const heightDim = pick(dims, ['höhe', 'hoehe', 'height'])
  const w = widthDim?.value ?? 90
  const h = heightDim?.value ?? 210
  const k = fitScale(w, h, 185, 170)
  const f = 9 // frame thickness (visual)
  const ox = 56
  const oy = 20
  const W = w * k
  const H = h * k
  const floorY = oy + H

  const frameOuter: Point[] = [
    [ox - f, floorY],
    [ox - f, oy - f],
    [ox + W + f, oy - f],
    [ox + W + f, floorY],
  ]
  const frameInner: Point[] = [
    [ox, floorY],
    [ox, oy],
    [ox + W, oy],
    [ox + W, floorY],
  ]

  return {
    viewW: ox + W + f + 62,
    viewH: floorY + 38,
    node: (
      <g>
        {/* floor line */}
        <line
          x1={ox - f - 26}
          y1={floorY}
          x2={ox + W + f + 48}
          y2={floorY}
          stroke="var(--foreground)"
          strokeWidth={1.4}
        />
        {/* frame (Stock) and clear opening */}
        {sketchPath(frameOuter, 'door-frame-outer', { strokeWidth: 1.4 })}
        {sketchPath(frameInner, 'door-frame-inner', { strokeWidth: 1.1 })}
        {/* leaf + handle */}
        {sketchRect(ox + 3, oy + 3, W - 6, H - 3, 'door-leaf', {
          strokeWidth: 1,
          stroke: 'var(--muted-foreground)',
        })}
        <circle
          cx={ox + W - 11}
          cy={oy + H * 0.52}
          r={2.4}
          fill="var(--muted-foreground)"
          opacity={0.85}
        />
        {/* lichte Durchgangsbreite — between the jambs, at the floor */}
        {widthDim && (
          <g>
            <ExtensionLine x1={ox} y1={floorY} x2={ox} y2={floorY + 20} />
            <ExtensionLine x1={ox + W} y1={floorY} x2={ox + W} y2={floorY + 20} />
            <DimensionArrow
              x1={ox}
              y1={floorY + 16}
              x2={ox + W}
              y2={floorY + 16}
              label={label(widthDim)}
              status={widthDim.status}
              labelOffset={9}
              fontSize={9.5}
            />
          </g>
        )}
        {/* Durchgangshöhe — floor to opening top */}
        {heightDim && (
          <g>
            <ExtensionLine x1={ox + W + f} y1={oy} x2={ox + W + f + 20} y2={oy} />
            <DimensionArrow
              x1={ox + W + f + 16}
              y1={floorY}
              x2={ox + W + f + 16}
              y2={oy}
              label={label(heightDim)}
              status={heightDim.status}
              labelOffset={13}
              fontSize={9.5}
            />
          </g>
        )}
      </g>
    ),
  }
}

/* ── ramp: side section with slope, handrail, length + height ─────────────── */

const toMetres = (d: DimensionCheckData | undefined): number | null =>
  d?.value == null ? null : (d.unit ?? 'cm') === 'cm' ? d.value / 100 : d.value

const rampTemplate = (dims: DimensionCheckData[]): Template => {
  const slopeDim = pick(dims, ['neigung', 'gefälle', 'gefaelle', 'steigung'], '%')
  const lengthDim = pick(dims, ['länge', 'laenge', 'length'])
  const heightDim = pick(dims, ['höhe', 'hoehe', 'height', 'niveau'])

  const slopePct = slopeDim?.value ?? 6
  const Lm = toMetres(lengthDim) ?? 6
  const riseM = toMetres(heightDim) ?? (Lm * slopePct) / 100

  const k = fitScale(Lm, Math.max(riseM, 0.6), 320, 100)
  // Handrail is a hint, not measured geometry — cap it so it never dwarfs a
  // shallow ramp wedge.
  const railH = Math.min(1.0 * k, 34)
  const x0 = 44
  const padTop = railH + 30
  const groundY = padTop + Math.max(riseM, 0.6) * k
  const endX = x0 + Lm * k
  const topY = groundY - riseM * k

  const yOnRamp = (t: number): number => groundY - riseM * k * t
  const xOnRamp = (t: number): number => x0 + Lm * k * t

  const angle = (Math.atan2(topY - groundY, endX - x0) * 180) / Math.PI
  const midX = (x0 + endX) / 2
  const midY = (groundY + topY) / 2

  return {
    viewW: endX + 68,
    viewH: groundY + 40,
    node: (
      <g>
        {/* ground with hatch ticks */}
        <line
          x1={x0 - 26}
          y1={groundY}
          x2={endX + 52}
          y2={groundY}
          stroke="var(--foreground)"
          strokeWidth={1.4}
        />
        {Array.from({ length: 9 }, (_, i) => {
          const x = x0 - 20 + i * ((endX + 44 - x0) / 8)
          return (
            <line
              key={`gh-${i}`}
              x1={x}
              y1={groundY}
              x2={x - 6}
              y2={groundY + 6}
              stroke="var(--muted-foreground)"
              strokeWidth={0.8}
              opacity={0.5}
            />
          )
        })}
        {/* ramp wedge */}
        {sketchPolygon(
          [
            [x0, groundY],
            [endX, groundY],
            [endX, topY],
          ],
          'ramp-wedge',
          { strokeWidth: 1.4, ...HATCH_LIGHT }
        )}
        {/* handrail hint: posts standing on the ramp surface, rail along the slope */}
        <g opacity={0.45}>
          {[0.08, 0.31, 0.54, 0.77, 1].map((t) => (
            <line
              key={`post-${t}`}
              x1={xOnRamp(t)}
              y1={yOnRamp(t)}
              x2={xOnRamp(t)}
              y2={yOnRamp(t) - railH}
              stroke="var(--muted-foreground)"
              strokeWidth={1}
            />
          ))}
          <line
            x1={xOnRamp(0.08)}
            y1={yOnRamp(0.08) - railH}
            x2={xOnRamp(1)}
            y2={yOnRamp(1) - railH}
            stroke="var(--muted-foreground)"
            strokeWidth={1.2}
          />
        </g>
        {/* slope, annotated along the incline */}
        {slopeDim && (
          <SvgLabel
            x={midX}
            y={midY - 10}
            anchor="middle"
            fill={statusColor(slopeDim.status)}
            weight={600}
            mono={slopeDim.value != null}
            italic={slopeDim.value == null}
            transform={`rotate(${angle} ${midX} ${midY - 10})`}
          >
            {label(slopeDim)}
          </SvgLabel>
        )}
        {/* length along the ground */}
        {lengthDim && (
          <g>
            <ExtensionLine x1={x0} y1={groundY} x2={x0} y2={groundY + 22} />
            <ExtensionLine x1={endX} y1={groundY} x2={endX} y2={groundY + 22} />
            <DimensionArrow
              x1={x0}
              y1={groundY + 18}
              x2={endX}
              y2={groundY + 18}
              label={label(lengthDim)}
              status={lengthDim.status}
              labelOffset={9}
              fontSize={9.5}
            />
          </g>
        )}
        {/* height to overcome, at the high end */}
        {heightDim && (
          <g>
            <ExtensionLine x1={endX} y1={topY} x2={endX + 20} y2={topY} />
            <DimensionArrow
              x1={endX + 16}
              y1={groundY}
              x2={endX + 16}
              y2={topY}
              label={label(heightDim)}
              status={heightDim.status}
              labelOffset={13}
              fontSize={9.5}
            />
          </g>
        )}
      </g>
    ),
  }
}

/* ── corridor: plan with two cut walls and the clear width between ────────── */

const corridorTemplate = (dims: DimensionCheckData[]): Template => {
  const widthDim = pick(dims, ['breite', 'width'])
  const w = widthDim?.value ?? 120
  const wallCm = 25
  const Lc = Math.max(w * 2.6, 280)
  const k = fitScale(Lc, w + 2 * wallCm, 330, 132)
  const x0 = 38
  const y0 = 18
  const wallT = wallCm * k
  const innerTop = y0 + wallT
  const innerBottom = innerTop + w * k
  const endX = x0 + Lc * k
  const dimX = x0 + Lc * k * 0.5

  return {
    viewW: endX + 40,
    viewH: innerBottom + wallT + 22,
    node: (
      <g>
        {sketchRect(x0, y0, Lc * k, wallT, 'corridor-wall-top', POCHE)}
        {sketchRect(x0, innerBottom, Lc * k, wallT, 'corridor-wall-bottom', POCHE)}
        {/* open ends marked with light break lines */}
        {[x0, endX].map((x) => (
          <line
            key={`end-${x}`}
            x1={x}
            y1={innerTop}
            x2={x}
            y2={innerBottom}
            stroke="var(--muted-foreground)"
            strokeWidth={0.8}
            strokeDasharray="3 4"
            opacity={0.6}
          />
        ))}
        {widthDim && (
          <DimensionArrow
            x1={dimX}
            y1={innerBottom}
            x2={dimX}
            y2={innerTop}
            label={label(widthDim)}
            status={widthDim.status}
            labelOffset={13}
            fontSize={9.5}
          />
        )}
      </g>
    ),
  }
}

/* ── turning circle: wheelchair turning clearance in a room corner ────────── */

const turningCircleTemplate = (dims: DimensionCheckData[]): Template => {
  const diaDim = pick(dims, ['durchmesser', 'wende', 'breite', 'diameter'])
  const d = diaDim?.value ?? 150
  const k = fitScale(d, d, 168, 168)
  const D = d * k
  const wallT = 11
  const x0 = 44
  const y0 = 34
  const cx = x0 + D / 2
  const cy = y0 + D / 2

  return {
    viewW: x0 + D + 46,
    viewH: y0 + D + 26,
    node: (
      <g>
        {/* room corner: top + left cut walls */}
        {sketchRect(x0 - 26, y0 - 26, D + 62, wallT, 'tc-wall-top', POCHE)}
        {sketchRect(x0 - 26, y0 - 26 + wallT, wallT, D + 44, 'tc-wall-left', POCHE)}
        {/* turning circle */}
        {sketchCircle(cx, cy, D, 'tc-circle', {
          stroke: diaDim ? statusColor(diaDim.status) : 'var(--foreground)',
          strokeWidth: 1.5,
        })}
        {/* centre cross */}
        <line x1={cx - 6} y1={cy} x2={cx + 6} y2={cy} stroke="var(--muted-foreground)" strokeWidth={0.9} />
        <line x1={cx} y1={cy - 6} x2={cx} y2={cy + 6} stroke="var(--muted-foreground)" strokeWidth={0.9} />
        {diaDim && (
          <DimensionArrow
            x1={cx - D / 2}
            y1={cy}
            x2={cx + D / 2}
            y2={cy}
            label={`Ø ${label(diaDim)}`}
            status={diaDim.status}
            labelOffset={-11}
            fontSize={9.5}
          />
        )}
      </g>
    ),
  }
}

/* ── threshold: door-sill detail, centimetre scale ────────────────────────── */

const thresholdTemplate = (dims: DimensionCheckData[]): Template => {
  const heightDim = pick(dims, ['höhe', 'hoehe', 'schwelle', 'height'])
  const t = heightDim?.value ?? 2
  const k = Math.min(fitScale(40, Math.max(t, 2) + 12, 250, 120), 9)
  const x0 = 60
  const spanCm = 40
  const bumpW = 8 * k
  const bumpH = Math.max(t, 0.4) * k
  const doorW = 4 * k
  const doorH = 9 * k
  const padTop = doorH + bumpH + 26
  const floorY = padTop + 8
  const bumpX = x0 + (spanCm * k - bumpW) / 2
  const doorX = bumpX + (bumpW - doorW) / 2
  const doorBottom = floorY - bumpH - 1.5

  return {
    viewW: x0 + spanCm * k + 66,
    viewH: floorY + 34,
    node: (
      <g>
        {/* floor slab both sides */}
        <line
          x1={x0 - 20}
          y1={floorY}
          x2={x0 + spanCm * k + 20}
          y2={floorY}
          stroke="var(--foreground)"
          strokeWidth={1.4}
        />
        {Array.from({ length: 8 }, (_, i) => {
          const x = x0 - 12 + i * ((spanCm * k + 24) / 7)
          return (
            <line
              key={`fh-${i}`}
              x1={x}
              y1={floorY}
              x2={x - 6}
              y2={floorY + 6}
              stroke="var(--muted-foreground)"
              strokeWidth={0.8}
              opacity={0.5}
            />
          )
        })}
        {/* threshold bump */}
        {sketchRect(bumpX, floorY - bumpH, bumpW, bumpH, 'threshold-bump', {
          strokeWidth: 1.3,
          ...HATCH_LIGHT,
        })}
        {/* door leaf above, cut off with a break line */}
        {sketchRect(doorX, doorBottom - doorH, doorW, doorH, 'threshold-door', {
          strokeWidth: 1,
          stroke: 'var(--muted-foreground)',
        })}
        <line
          x1={doorX - 5}
          y1={doorBottom - doorH + 3}
          x2={doorX + doorW + 5}
          y2={doorBottom - doorH - 3}
          stroke="var(--card)"
          strokeWidth={5}
        />
        <line
          x1={doorX - 5}
          y1={doorBottom - doorH + 3}
          x2={doorX + doorW + 5}
          y2={doorBottom - doorH - 3}
          stroke="var(--muted-foreground)"
          strokeWidth={0.9}
        />
        {/* threshold height */}
        {heightDim && (
          <g>
            <ExtensionLine
              x1={bumpX + bumpW}
              y1={floorY - bumpH}
              x2={bumpX + bumpW + 26}
              y2={floorY - bumpH}
            />
            <DimensionArrow
              x1={bumpX + bumpW + 22}
              y1={floorY}
              x2={bumpX + bumpW + 22}
              y2={floorY - bumpH}
              label={label(heightDim)}
              status={heightDim.status}
              labelOffset={13}
              fontSize={9.5}
            />
          </g>
        )}
      </g>
    ),
  }
}

/* ── parking space: accessible bay in plan ────────────────────────────────── */

const parkingTemplate = (dims: DimensionCheckData[]): Template => {
  const widthDim = pick(dims, ['breite', 'width'])
  const lengthDim = pick(dims, ['länge', 'laenge', 'tiefe', 'length'])
  const w = widthDim?.value ?? 350
  const l = lengthDim?.value ?? 500
  const k = fitScale(l, w, 280, 165)
  const x0 = 56
  const y0 = 18
  const W = l * k
  const H = w * k

  return {
    viewW: x0 + W + 34,
    viewH: y0 + H + 38,
    node: (
      <g>
        {sketchRect(x0, y0, W, H, 'parking-bay', { strokeWidth: 1.5 })}
        <SvgLabel
          x={x0 + W / 2}
          y={y0 + H / 2}
          anchor="middle"
          size={26}
          weight={700}
          fill="color-mix(in oklch, var(--muted-foreground) 55%, transparent)"
        >
          P
        </SvgLabel>
        {widthDim && (
          <g>
            <ExtensionLine x1={x0} y1={y0} x2={x0 - 20} y2={y0} />
            <ExtensionLine x1={x0} y1={y0 + H} x2={x0 - 20} y2={y0 + H} />
            <DimensionArrow
              x1={x0 - 16}
              y1={y0 + H}
              x2={x0 - 16}
              y2={y0}
              label={label(widthDim)}
              status={widthDim.status}
              labelOffset={-13}
              fontSize={9.5}
            />
          </g>
        )}
        {lengthDim && (
          <g>
            <ExtensionLine x1={x0} y1={y0 + H} x2={x0} y2={y0 + H + 22} />
            <ExtensionLine x1={x0 + W} y1={y0 + H} x2={x0 + W} y2={y0 + H + 22} />
            <DimensionArrow
              x1={x0}
              y1={y0 + H + 18}
              x2={x0 + W}
              y2={y0 + H + 18}
              label={label(lengthDim)}
              status={lengthDim.status}
              labelOffset={9}
              fontSize={9.5}
            />
          </g>
        )}
      </g>
    ),
  }
}

const TEMPLATES: Record<Shape, (dims: DimensionCheckData[]) => Template> = {
  door: doorTemplate,
  ramp: rampTemplate,
  corridor: corridorTemplate,
  turning_circle: turningCircleTemplate,
  threshold: thresholdTemplate,
  parking_space: parkingTemplate,
}

export const DimensionDiagramCard: FC<DimensionDiagramCardProps> = ({
  title,
  shape,
  dimensions,
  reference,
  note,
}) => {
  const template = (TEMPLATES[shape] ?? doorTemplate)(dimensions)

  return (
    <SchematicCard
      icon={Ruler}
      eyebrow="Schematic"
      title={title}
      verdict={worstStatus(dimensions.map((d) => d.status))}
      note={note}
      reference={reference}
    >
      <SchematicCanvas
        viewW={template.viewW}
        viewH={template.viewH}
        minWidth={template.minWidth ?? Math.min(template.viewW, 380)}
        label={title}
      >
        {template.node}
      </SchematicCanvas>
      <DimChecksList checks={dimensions} />
    </SchematicCard>
  )
}
