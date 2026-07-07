/**
 * ElevatorRequirementCard — barrierefreier Aufzug: served storeys as a stack
 * with a lift shaft, the requirement verdict, and cabin/door clearance checks.
 *
 * The building is drawn as N stacked storey bands with a lift shaft on the
 * right running through them and a cabin cab at the entrance level. A pill
 * states whether a barrier-free lift is required. Below, the cabin width/depth
 * and clear door width are read against the accessibility minimums; unknown
 * dimensions read "fehlende Angabe", never a guess.
 */

import { type FC } from 'react'
import { ArrowUpDown } from 'lucide-react'
import {
  DimChecksList,
  SchematicCanvas,
  SchematicCard,
  StatusBadge,
  SvgLabel,
  worstStatus,
} from './kit'
import { sketchRect } from './rough'
import type { DimensionCheckData, DimStatus, NormReferenceData } from './types'

interface ElevatorRequirementCardProps {
  title: string
  storeys_served: number
  entrance_level_index?: number | null
  is_required?: boolean | null
  requirement_note?: string | null
  cabin_width?: DimensionCheckData | null
  cabin_depth?: DimensionCheckData | null
  door_width?: DimensionCheckData | null
  reference?: NormReferenceData | null
  note?: string | null
}

export const ElevatorRequirementCard: FC<ElevatorRequirementCardProps> = ({
  title,
  storeys_served: storeysServed,
  entrance_level_index: entranceIndex,
  is_required: isRequired,
  requirement_note: requirementNote,
  cabin_width: cabinWidth,
  cabin_depth: cabinDepth,
  door_width: doorWidth,
  reference,
  note,
}) => {
  const n = Math.max(1, Math.min(storeysServed, 12))
  const entrance = entranceIndex ?? 0

  const bandH = Math.max(16, Math.min(30, 190 / n))
  const px = 20
  const bw = 176
  const shaftW = 40
  const gap = 4
  const top = 22
  const viewW = 300
  const viewH = top + n * (bandH + gap) + 8

  // Requirement pill maps the boolean to a verdict-style status.
  const reqStatus: DimStatus | null =
    isRequired == null ? null : isRequired ? 'warning' : 'pass'

  const checks = [cabinWidth, cabinDepth, doorWidth].filter(
    (c): c is DimensionCheckData => c != null
  )

  const shaftX = px + bw - shaftW - 6

  return (
    <SchematicCard
      icon={ArrowUpDown}
      eyebrow="Schematic"
      title={title}
      verdict={worstStatus(checks.map((c) => c.status))}
      note={note}
      reference={reference}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Barrierefreier Aufzug:</span>
        {reqStatus ? (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            {isRequired ? 'erforderlich' : 'nicht erforderlich'}
            <StatusBadge status={reqStatus} />
          </span>
        ) : (
          <span className="italic text-muted-foreground">Angabe fehlt</span>
        )}
      </div>
      {requirementNote && (
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{requirementNote}</p>
      )}

      <SchematicCanvas viewW={viewW} viewH={viewH} minWidth={300} label={title}>
        {/* storey stack, top storey first */}
        {[...Array(n)].map((_, row) => {
          // row 0 at the top → storey index counts down from the top.
          const storeyIdx = n - 1 - row
          const y = top + row * (bandH + gap)
          const isEntrance = storeyIdx === entrance
          return (
            <g key={`st-${row}`}>
              {sketchRect(px, y, bw, bandH, `st-${row}`, {
                strokeWidth: 1.2,
                fill: isEntrance ? 'color-mix(in oklch, var(--foreground) 6%, transparent)' : undefined,
              })}
              {isEntrance && (
                <SvgLabel x={px + 8} y={y + bandH / 2} weight={600} size={9}>
                  Zugangsebene
                </SvgLabel>
              )}
            </g>
          )
        })}

        {/* lift shaft through the full height */}
        <rect
          x={shaftX}
          y={top}
          width={shaftW}
          height={n * (bandH + gap) - gap}
          fill="color-mix(in oklch, var(--text-color-feedback-info) 10%, transparent)"
          stroke="var(--text-color-feedback-info)"
          strokeWidth={1.2}
        />
        {/* cabin at the entrance level */}
        {(() => {
          const row = n - 1 - entrance
          const y = top + row * (bandH + gap)
          return (
            <rect
              x={shaftX + 5}
              y={y + 3}
              width={shaftW - 10}
              height={bandH - 6}
              fill="var(--card)"
              stroke="var(--text-color-feedback-info)"
              strokeWidth={1.4}
            />
          )
        })()}
        <SvgLabel x={shaftX + shaftW / 2} y={top - 10} anchor="middle" fill="var(--text-color-feedback-info)" size={9}>
          Aufzug
        </SvgLabel>
      </SchematicCanvas>

      {checks.length > 0 && <DimChecksList checks={checks} />}
    </SchematicCard>
  )
}
