/**
 * ParkingRequirementCard — Stellplatznachweis: provided vs required parking
 * shown as a slot grid plus a limit bar (Bauordnung / Stellplatzverordnung).
 *
 * Each check draws a grid of slot glyphs: provided slots are filled neutral
 * (they exist — existence is not a verdict), missing slots are dashed
 * danger-coloured gaps, surplus slots beyond the requirement are tinted
 * success. A caption states the count in words ("12 von 14 nachgewiesen — 2
 * fehlen") and a LimitBar reads provided against required (more is better).
 * Cars are always shown; bicycles when supplied. Unknown counts render an
 * empty track and "fehlende Angabe" — never a guessed number.
 */

import { type FC, type ReactNode } from 'react'
import { SquareParking } from 'lucide-react'
import {
  fmtNum,
  LimitBar,
  MISSING_LABEL,
  SchematicCanvas,
  SchematicCard,
  statusColor,
  worstStatus,
} from './kit'
import type { DimensionCheckData, NormReferenceData } from './types'

interface ParkingRequirementCardProps {
  title: string
  car_spaces: DimensionCheckData
  bicycle_spaces?: DimensionCheckData | null
  basis?: string | null
  reference?: NormReferenceData | null
  note?: string | null
}

const COLS = 14
const CELL = 15
const PAD = 3
const SLOT_CAP = 70

/**
 * One slot grid: filled neutral = provided, dashed danger = missing against
 * the requirement, success-tinted = surplus beyond it.
 */
const SlotGrid: FC<{ check: DimensionCheckData }> = ({ check }) => {
  const provided = check.value ?? null
  const required = check.required ?? null
  const total = Math.min(Math.max(provided ?? 0, required ?? 0), SLOT_CAP)

  if (provided == null && required == null) {
    return (
      <p className="text-xs italic text-muted-foreground">
        {check.label}: {MISSING_LABEL}
      </p>
    )
  }

  const rows = Math.max(1, Math.ceil(total / COLS))
  const viewW = COLS * CELL + PAD * 2
  const viewH = rows * CELL + PAD * 2
  const success = statusColor('pass')
  const danger = statusColor('fail')
  const cells: ReactNode[] = []
  for (let i = 0; i < total; i += 1) {
    const cx = PAD + (i % COLS) * CELL
    const cy = PAD + Math.floor(i / COLS) * CELL
    const filled = provided != null && i < provided
    const surplus = required != null && i >= required
    cells.push(
      <rect
        key={i}
        x={cx + 1.5}
        y={cy + 1.5}
        width={CELL - 4}
        height={CELL - 4}
        rx={2}
        fill={
          filled
            ? surplus
              ? `color-mix(in oklch, ${success} 45%, transparent)`
              : 'color-mix(in oklch, var(--foreground) 55%, transparent)'
            : 'none'
        }
        stroke={filled ? (surplus ? success : 'var(--foreground)') : danger}
        strokeOpacity={filled ? 0.65 : 0.9}
        strokeWidth={1}
        strokeDasharray={filled ? undefined : '3 2'}
      />
    )
  }

  return (
    <SchematicCanvas viewW={viewW} viewH={viewH} label={check.label}>
      {cells}
    </SchematicCanvas>
  )
}

/** "12 von 14 nachgewiesen — 2 fehlen" / "28 nachgewiesen (Überschuss +4)". */
const countCaption = (check: DimensionCheckData): string | null => {
  const provided = check.value ?? null
  const required = check.required ?? null
  if (provided == null || required == null) return null
  const overflow = Math.max(provided, required) > SLOT_CAP ? ' (Ausschnitt)' : ''
  if (provided < required)
    return `${fmtNum(provided)} von ${fmtNum(required)} nachgewiesen — ${fmtNum(required - provided)} fehlen${overflow}`
  if (provided > required)
    return `${fmtNum(provided)} nachgewiesen — Überschuss +${fmtNum(provided - required)}${overflow}`
  return `${fmtNum(provided)} von ${fmtNum(required)} nachgewiesen${overflow}`
}

const withDefaults = (check: DimensionCheckData, fallbackLabel: string): DimensionCheckData => ({
  ...check,
  label: check.label || fallbackLabel,
  unit: check.unit ?? 'Stpl.',
  comparator: check.comparator ?? '>=',
})

export const ParkingRequirementCard: FC<ParkingRequirementCardProps> = ({
  title,
  car_spaces: carSpaces,
  bicycle_spaces: bicycleSpaces,
  basis,
  reference,
  note,
}) => {
  const car = withDefaults(carSpaces, 'Kfz-Stellplätze')
  const bike = bicycleSpaces ? withDefaults(bicycleSpaces, 'Fahrradabstellplätze') : null

  return (
    <SchematicCard
      icon={SquareParking}
      eyebrow="Skizze"
      title={title}
      verdict={worstStatus([car.status, ...(bike ? [bike.status] : [])])}
      note={note}
      reference={reference}
    >
      {basis && (
        <p className="text-xs text-muted-foreground">
          Bemessung: <span className="text-foreground">{basis}</span>
        </p>
      )}

      {[car, ...(bike ? [bike] : [])].map((check, i) => {
        const caption = countCaption(check)
        return (
          <div key={`grid-${i}`} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-xs font-medium text-foreground">{check.label}</p>
              {caption && (
                <p className="text-[11px]" style={{ color: statusColor(check.status) }}>
                  {caption}
                </p>
              )}
            </div>
            <SlotGrid check={check} />
            <LimitBar check={check} />
          </div>
        )
      })}

      <p className="text-[11px] text-muted-foreground">
        Gefüllt = nachgewiesen, gestrichelt = fehlend gegenüber der Anforderung.
      </p>
    </SchematicCard>
  )
}
