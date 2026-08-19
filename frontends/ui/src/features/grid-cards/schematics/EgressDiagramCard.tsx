/**
 * EgressDiagramCard — a Fluchtweg drawn to scale from the worst-case point to
 * the exit, with the total walking length checked against the OIB 2 limit.
 *
 * Segments render as one connected polyline honouring each run's turn
 * (straight / left / right, 90° in plan), over a soft "corridor" underlay.
 * The path is coloured by the total-length verdict; each run is annotated
 * with its label and length. A start dot marks the worst-case point, an
 * arrowhead + door tick mark the exit. Below the drawing a LimitBar reads the
 * summed length against the required maximum.
 */

import { type FC } from 'react'
import { Route } from 'lucide-react'
import {
  fitScale,
  fmtNum,
  LimitBar,
  SchematicCanvas,
  SchematicCard,
  statusColor,
  SvgLabel,
} from './kit'
import { sketchPath, type Point } from './rough'
import { useTranslations } from '@/i18n'
import type { DimensionCheckData, EgressSegmentData, NormReferenceData } from './types'

interface EgressDiagramCardProps {
  title: string
  segments: EgressSegmentData[]
  total_length: DimensionCheckData
  start_label?: string | null
  exit_label?: string | null
  reference?: NormReferenceData | null
}

export const EgressDiagramCard: FC<EgressDiagramCardProps> = ({
  title,
  segments,
  total_length,
  start_label,
  exit_label,
  reference,
}) => {
  const t = useTranslations('chat')
  // Trace the path in metres: start heading +x; a "left" turn after a run is
  // counter-clockwise when walking (−y with SVG's y-down), "right" clockwise.
  let dirX = 1
  let dirY = 0
  let cx = 0
  let cy = 0
  const runs = segments.map((segment) => {
    const from: [number, number] = [cx, cy]
    cx += dirX * segment.length_m
    cy += dirY * segment.length_m
    const to: [number, number] = [cx, cy]
    const run = { segment, from, to, dirX, dirY }
    if (segment.turn === 'left') {
      const nx = dirY
      const ny = -dirX
      dirX = nx
      dirY = ny
    } else if (segment.turn === 'right') {
      const nx = -dirY
      const ny = dirX
      dirX = nx
      dirY = ny
    }
    return run
  })

  const xs = [0, ...runs.flatMap((r) => [r.from[0], r.to[0]])]
  const ys = [0, ...runs.flatMap((r) => [r.from[1], r.to[1]])]
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = Math.max(maxX - minX, 1)
  const spanY = Math.max(maxY - minY, 1)

  const k = fitScale(spanX, spanY, 380, 200)
  const padL = 52
  const padTop = 44
  const X = (m: number): number => padL + (m - minX) * k
  const Y = (m: number): number => padTop + (m - minY) * k

  const points: Point[] = [[X(runs[0]?.from[0] ?? 0), Y(runs[0]?.from[1] ?? 0)]]
  runs.forEach((r) => points.push([X(r.to[0]), Y(r.to[1])]))

  const pathColor = statusColor(total_length.status)
  const startX = points[0][0]
  const startY = points[0][1]
  const end = points[points.length - 1]
  const last = runs[runs.length - 1]

  // Exit arrowhead + door tick, oriented along the final run.
  const eu = last ? { x: last.dirX, y: last.dirY } : { x: 1, y: 0 }
  const exitHead = `M ${end[0] - eu.x * 8 - eu.y * 4.5} ${end[1] - eu.y * 8 + eu.x * 4.5} L ${end[0]} ${end[1]} L ${end[0] - eu.x * 8 + eu.y * 4.5} ${end[1] - eu.y * 8 - eu.x * 4.5}`
  const doorTick = `M ${end[0] + eu.x * 4 - eu.y * 7} ${end[1] + eu.y * 4 + eu.x * 7} L ${end[0] + eu.x * 4 + eu.y * 7} ${end[1] + eu.y * 4 - eu.x * 7}`

  const viewW = padL + spanX * k + 96
  const viewH = padTop + spanY * k + 40

  const summedLength = segments.reduce((sum, s) => sum + s.length_m, 0)
  const totalCheck: DimensionCheckData = {
    ...total_length,
    unit: total_length.unit ?? 'm',
    // The sum of the given runs is arithmetic on provided data, not a guess —
    // use it when the model left the total null.
    value: total_length.value ?? (segments.length > 0 ? summedLength : null),
  }

  return (
    <SchematicCard icon={Route} title={title} verdict={total_length.status} reference={reference}>
      <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
        {/* corridor underlay */}
        <polyline
          points={points.map((p) => p.join(',')).join(' ')}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={12}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* escape path */}
        {sketchPath(points, 'egress-path', {
          stroke: pathColor,
          strokeWidth: 2,
          roughness: 0.7,
        })}

        {/* per-run annotation: label above the run, length below */}
        {runs.map((r, i) => {
          const mx = (X(r.from[0]) + X(r.to[0])) / 2
          const my = (Y(r.from[1]) + Y(r.to[1])) / 2
          const horizontal = r.dirY === 0
          const lx = horizontal ? mx : mx + 12
          const ly = horizontal ? my : my
          return (
            <g key={`run-${i}`}>
              <SvgLabel
                x={horizontal ? lx : lx + 2}
                y={horizontal ? ly - 16 : ly - 6}
                anchor={horizontal ? 'middle' : 'start'}
                size={8.5}
              >
                {r.segment.label}
              </SvgLabel>
              <SvgLabel
                x={horizontal ? lx : lx + 2}
                y={horizontal ? ly - 6 : ly + 6}
                anchor={horizontal ? 'middle' : 'start'}
                mono
                size={9}
                fill="var(--foreground)"
              >
                {fmtNum(r.segment.length_m)} m
              </SvgLabel>
            </g>
          )
        })}

        {/* start: worst-case point */}
        <circle cx={startX} cy={startY} r={4} fill={pathColor} />
        <circle cx={startX} cy={startY} r={8} fill="none" stroke={pathColor} strokeWidth={1} opacity={0.5} />
        {start_label && (
          <SvgLabel x={startX} y={startY + 18} anchor="middle" size={8.5} italic>
            {start_label}
          </SvgLabel>
        )}

        {/* exit: arrowhead + door tick */}
        <path d={exitHead} stroke={pathColor} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d={doorTick} stroke="var(--foreground)" strokeWidth={2.2} strokeLinecap="round" />
        {exit_label && (
          <SvgLabel x={end[0]} y={end[1] + 18} anchor="middle" size={8.5} weight={600} fill="var(--foreground)">
            {exit_label}
          </SvgLabel>
        )}
      </SchematicCanvas>

      <LimitBar
        check={{
          ...totalCheck,
          label: totalCheck.label || t('cards.schematics.egress.totalWalkLength'),
        }}
      />
    </SchematicCard>
  )
}
