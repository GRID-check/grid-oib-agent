/**
 * ElevatorRequirementCard — barrierefreier Aufzug: served storeys as a stack
 * with a lift shaft, the requirement verdict, and cabin/door clearance checks.
 *
 * The building is one contiguous outline with storey separator lines and
 * generated storey labels (KG/EG/OG from the entrance level); the lift shaft
 * runs inside it over the full height with the cabin at the entrance level and
 * a travel arrow above it. The requirement itself is stated as a neutral
 * info chip ("erforderlich" / "nicht erforderlich") — it is a fact, not a
 * pass/fail verdict. Below, the cabin width/depth and clear door width are
 * read against the accessibility minimums; unknown dimensions read
 * "fehlende Angabe", never a guess.
 */

import { type FC } from 'react'
import { CircleHelp } from 'lucide-react'
import { DimChecksList, SchematicCard, worstStatus } from '../cards/shell'
import { SchematicCanvas, SvgLabel } from './draw'
import { cn } from '@/lib/utils'
import { sketchLine, sketchRect } from './rough'
import { useTranslations, type Translator } from '@/i18n'
import type { DimensionCheckData, NormReferenceData } from './types'

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

/** Storey label relative to the entrance level: 2.KG … EG … 3.OG. */
const storeyName = (index: number, entrance: number, t: Translator): string => {
  if (index === entrance) return t('cards.schematics.elevator.groundFloor')
  if (index > entrance)
    return t('cards.schematics.elevator.upperFloor', { level: index - entrance })
  return t('cards.schematics.elevator.basement', { level: entrance - index })
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
  const t = useTranslations('chat')
  const n = Math.max(1, Math.min(storeysServed, 12))
  const entrance = Math.max(0, Math.min(entranceIndex ?? 0, n - 1))

  const bandH = Math.max(18, Math.min(30, 180 / n))
  const bx = 64
  const bw = 180
  const shaftW = 38
  const top = 30
  const buildingH = n * bandH
  const groundY = top + (n - entrance) * bandH
  const viewW = 330
  const viewH = top + buildingH + (entrance > 0 ? 10 : 0) + 22

  const checks = [cabinWidth, cabinDepth, doorWidth].filter(
    (c): c is DimensionCheckData => c != null
  )

  const shaftX = bx + bw - shaftW - 14
  const info = 'var(--text-color-feedback-info)'

  return (
    <SchematicCard
      title={title}
      verdict={worstStatus(checks.map((c) => c.status))}
      note={note}
      reference={reference}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t('cards.schematics.elevator.accessible')}:</span>
        {isRequired == null ? (
          <span className="inline-flex items-center gap-1 italic text-muted-foreground">
            <CircleHelp className="size-3.5" aria-hidden="true" />
            {t('cards.kit.status.needsInput')}
          </span>
        ) : (
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-medium',
              isRequired ? 'bg-info-subtle text-info' : 'bg-muted text-muted-foreground'
            )}
          >
            {isRequired
              ? t('cards.schematics.elevator.required')
              : t('cards.schematics.elevator.notRequired')}
          </span>
        )}
      </div>
      {requirementNote && (
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{requirementNote}</p>
      )}

      <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
        {/* one contiguous building outline */}
        {sketchRect(bx, top, bw, buildingH, 'lift-building', { strokeWidth: 1.5 })}

        {/* storey bands: separators, entrance tint, generated labels */}
        {[...Array(n)].map((_, row) => {
          const storeyIdx = n - 1 - row // row 0 at the top
          const y = top + row * bandH
          const isEntrance = storeyIdx === entrance
          return (
            <g key={`st-${row}`}>
              {isEntrance && (
                <rect
                  x={bx + 1.5}
                  y={y + 1}
                  width={bw - 3}
                  height={bandH - 2}
                  fill="color-mix(in oklch, var(--foreground) 5%, transparent)"
                />
              )}
              {row > 0 && sketchLine(bx, y, bx + bw, y, `lift-slab-${row}`, { strokeWidth: 0.9 })}
              <SvgLabel
                x={bx + 9}
                y={y + bandH / 2}
                weight={isEntrance ? 600 : 500}
                size={9}
                fill={isEntrance ? 'var(--foreground)' : 'var(--muted-foreground)'}
              >
                {storeyName(storeyIdx, entrance, t)}
              </SvgLabel>
              {isEntrance && (
                <SvgLabel x={bx + 38} y={y + bandH / 2} size={8} italic>
                  {t('cards.schematics.elevator.entranceLevel')}
                </SvgLabel>
              )}
            </g>
          )
        })}

        {/* ground line at the entrance level, with hatch ticks */}
        <line
          x1={bx - 26}
          y1={groundY}
          x2={bx + bw + 26}
          y2={groundY}
          stroke="var(--foreground)"
          strokeWidth={1.4}
        />
        {Array.from({ length: 4 }, (_, i) => (
          <line
            key={`gl-${i}`}
            x1={bx - 22 + i * 7}
            y1={groundY}
            x2={bx - 27 + i * 7}
            y2={groundY + 6}
            stroke="var(--muted-foreground)"
            strokeWidth={0.8}
            opacity={0.55}
          />
        ))}
        {Array.from({ length: 4 }, (_, i) => (
          <line
            key={`gr-${i}`}
            x1={bx + bw + 6 + i * 7}
            y1={groundY}
            x2={bx + bw + 1 + i * 7}
            y2={groundY + 6}
            stroke="var(--muted-foreground)"
            strokeWidth={0.8}
            opacity={0.55}
          />
        ))}

        {/* lift shaft inside the building, full height */}
        <rect
          x={shaftX}
          y={top}
          width={shaftW}
          height={buildingH}
          fill={`color-mix(in oklch, ${info} 8%, transparent)`}
          stroke={info}
          strokeWidth={1.1}
        />
        {/* cabin at the entrance level */}
        {(() => {
          const y = top + (n - 1 - entrance) * bandH
          return (
            <g>
              <rect
                x={shaftX + 5}
                y={y + 3}
                width={shaftW - 10}
                height={bandH - 6}
                fill="var(--card)"
                stroke={info}
                strokeWidth={1.4}
              />
              {/* travel arrow above the cabin */}
              {entrance < n - 1 && (
                <g stroke={info} strokeWidth={1.1} opacity={0.8}>
                  <line x1={shaftX + shaftW / 2} y1={y - 4} x2={shaftX + shaftW / 2} y2={top + 8} />
                  <path
                    d={`M ${shaftX + shaftW / 2 - 3.5} ${top + 12} L ${shaftX + shaftW / 2} ${top + 6} L ${shaftX + shaftW / 2 + 3.5} ${top + 12}`}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              )}
            </g>
          )
        })()}
        <SvgLabel
          x={shaftX + shaftW / 2}
          y={top - 10}
          anchor="middle"
          fill={info}
          size={9}
          weight={600}
        >
          {t('cards.schematics.elevator.shaft')}
        </SvgLabel>

        {/* storey count, bottom left */}
        <SvgLabel x={bx} y={top + buildingH + 14} size={8.5}>
          {n} Geschosse erschlossen
        </SvgLabel>
      </SchematicCanvas>

      {checks.length > 0 && <DimChecksList checks={checks} />}
    </SchematicCard>
  )
}
