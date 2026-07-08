/**
 * BuildingSectionCard — a to-scale building cross-section for height /
 * Gebäudeklasse / Fluchtniveau questions.
 *
 * Storey bands stack to scale above (and hatched below) a strong ground line
 * with the classic hatch ticks; dashed horizontal marker lines cross the
 * section at each threshold height with right-side labels. Fluchtniveau reads
 * in info blue, GK/Hochhaus thresholds in warning amber, plain references in
 * muted grey. A neutral dimension arrow on the left totals the above-grade
 * height so the building can be read against the limits at a glance.
 */

import { type FC, type ReactNode } from 'react'
import { Building2 } from 'lucide-react'
import {
  DimensionArrow,
  ExtensionLine,
  fmtNum,
  SchematicCanvas,
  SchematicCard,
  SvgLabel,
} from './kit'
import { sketchLine, sketchRect } from './rough'
import type { NormReferenceData, SectionMarkerData, SectionStoreyData } from './types'

interface BuildingSectionCardProps {
  title: string
  storeys: SectionStoreyData[]
  markers?: SectionMarkerData[] | null
  reference?: NormReferenceData | null
  note?: string | null
}

const MARKER_STYLE: Record<
  NonNullable<SectionMarkerData['kind']>,
  { color: string; dash: string; width: number }
> = {
  fluchtniveau: { color: 'var(--text-color-feedback-info)', dash: '7 4', width: 1.4 },
  threshold: { color: 'var(--text-color-feedback-warning)', dash: '7 4', width: 1.4 },
  reference: { color: 'var(--muted-foreground)', dash: '3 4', width: 1 },
}

export const BuildingSectionCard: FC<BuildingSectionCardProps> = ({
  title,
  storeys,
  markers,
  reference,
  note,
}) => {
  const above = storeys.filter((s) => !s.below_grade)
  const below = storeys.filter((s) => s.below_grade)
  const aboveH = above.reduce((sum, s) => sum + s.height_m, 0)
  const belowH = below.reduce((sum, s) => sum + s.height_m, 0)
  const markerList = markers ?? []
  const maxMarkerH = markerList.reduce((max, m) => Math.max(max, m.height_m), 0)

  // Vertical extent in metres: headroom above the taller of building/markers,
  // a little soil below the deepest basement.
  const topM = Math.max(aboveH, maxMarkerH) + 0.9
  const totalM = topM + belowH + (belowH > 0 ? 0.5 : 0.3)
  const k = Math.min(26, 300 / totalM) // px per metre, capped for short buildings

  const padTop = 14
  const viewW = 470
  const bx = 92
  const bw = 168
  const groundY = padTop + topM * k
  const yAt = (heightM: number): number => groundY - heightM * k
  const viewH = padTop + totalM * k + 18

  // Above-grade storey bands, bottom-to-top.
  const aboveBands: ReactNode[] = []
  let cursor = 0
  above.forEach((storey, i) => {
    const y0 = yAt(cursor + storey.height_m)
    const hPx = storey.height_m * k
    const midY = y0 + hPx / 2
    aboveBands.push(
      <g key={`above-${i}`}>
        {i % 2 === 1 && (
          <rect
            x={bx}
            y={y0}
            width={bw}
            height={hPx}
            fill="color-mix(in oklch, var(--foreground) 4%, transparent)"
          />
        )}
        {i > 0 && sketchLine(bx, y0 + hPx, bx + bw, y0 + hPx, `slab-${i}`, { strokeWidth: 1 })}
        <SvgLabel x={bx + 9} y={midY} weight={600} fill="var(--foreground)" size={10}>
          {storey.label}
        </SvgLabel>
        <SvgLabel x={bx + bw - 9} y={midY} anchor="end" mono size={9.5}>
          {fmtNum(storey.height_m)} m
        </SvgLabel>
      </g>
    )
    cursor += storey.height_m
  })

  // Below-grade bands, hatched, deepest first in the input list.
  const belowBands: ReactNode[] = []
  let depth = belowH
  below.forEach((storey, i) => {
    const yTop = yAt(-(depth - storey.height_m))
    const hPx = storey.height_m * k
    const midY = yTop + hPx / 2
    belowBands.push(
      <g key={`below-${i}`} opacity={0.8}>
        {sketchRect(bx, yTop, bw, hPx, `basement-${i}`, {
          strokeLineDash: [5, 4],
          strokeWidth: 1,
          stroke: 'var(--muted-foreground)',
          fill: 'color-mix(in oklch, var(--muted-foreground) 45%, transparent)',
          fillStyle: 'hachure',
          fillWeight: 0.5,
          hachureGap: 8,
        })}
        <SvgLabel x={bx + 9} y={midY} weight={600} size={10}>
          {storey.label}
        </SvgLabel>
        <SvgLabel x={bx + bw - 9} y={midY} anchor="end" mono size={9.5}>
          {fmtNum(storey.height_m)} m
        </SvgLabel>
      </g>
    )
    depth -= storey.height_m
  })

  // Ground hatch ticks left and right of the building.
  const groundTicks: ReactNode[] = []
  for (let x = 46; x <= 312; x += 12) {
    if (x > bx - 8 && x < bx + bw + 8) continue
    groundTicks.push(
      <line
        key={`tick-${x}`}
        x1={x}
        y1={groundY}
        x2={x - 7}
        y2={groundY + 7}
        stroke="var(--muted-foreground)"
        strokeWidth={0.8}
        opacity={0.5}
      />
    )
  }

  return (
    <SchematicCard
      icon={Building2}
      eyebrow="Schematic"
      title={title}
      note={note}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} minWidth={430} label={title}>
        {/* below-grade block behind the ground line */}
        {belowBands}

        {/* above-grade building outline + bands */}
        {aboveH > 0 &&
          sketchRect(bx, yAt(aboveH), bw, aboveH * k, 'building-outline', { strokeWidth: 1.5 })}
        {aboveBands}

        {/* ground line with hatch ticks and ±0,00 datum */}
        <line
          x1={40}
          y1={groundY}
          x2={318}
          y2={groundY}
          stroke="var(--foreground)"
          strokeWidth={1.5}
        />
        {groundTicks}
        <SvgLabel x={318} y={groundY - 8} anchor="end" mono size={9}>
          ±0,00
        </SvgLabel>

        {/* marker lines: Fluchtniveau / GK thresholds / references */}
        {markerList.map((marker, i) => {
          const style = MARKER_STYLE[marker.kind ?? 'reference']
          const y = yAt(marker.height_m)
          return (
            <g key={`marker-${i}`}>
              <line
                x1={52}
                y1={y}
                x2={318}
                y2={y}
                stroke={style.color}
                strokeWidth={style.width}
                strokeDasharray={style.dash}
              />
              <SvgLabel x={324} y={y - 5} fill={style.color} weight={600} size={10}>
                {marker.label}
              </SvgLabel>
              <SvgLabel x={324} y={y + 7} mono size={9}>
                +{fmtNum(marker.height_m)} m
              </SvgLabel>
            </g>
          )
        })}

        {/* total above-grade height, measured at the left */}
        {aboveH > 0 && (
          <g>
            <ExtensionLine x1={bx - 4} y1={yAt(aboveH)} x2={60} y2={yAt(aboveH)} />
            <DimensionArrow
              x1={66}
              y1={groundY}
              x2={66}
              y2={yAt(aboveH)}
              label={`${fmtNum(aboveH)} m`}
              color="var(--foreground)"
              labelOffset={-11}
            />
          </g>
        )}
      </SchematicCanvas>
    </SchematicCard>
  )
}
