/**
 * ParkingRequirementCard — Stellplatznachweis: provided vs required parking
 * shown as a slot grid plus a limit bar (Bauordnung / Stellplatzverordnung).
 *
 * Each check draws a grid of slot glyphs: outline slots for the required
 * minimum, status-filled slots for those provided (extra provided slots read
 * as a surplus). A LimitBar reads provided against required (more is better).
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

const COLS = 10
const CELL = 22
const PAD = 6

/** One labelled slot grid: outline = required, filled = provided. */
const SlotGrid: FC<{ check: DimensionCheckData }> = ({ check }) => {
  const provided = check.value ?? null
  const required = check.required ?? null
  const total = Math.min(Math.max(provided ?? 0, required ?? 0), 60)
  const color = statusColor(check.status)

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
  const cells: ReactNode[] = []
  for (let i = 0; i < total; i += 1) {
    const cx = PAD + (i % COLS) * CELL
    const cy = PAD + Math.floor(i / COLS) * CELL
    const filled = provided != null && i < provided
    const surplus = required != null && i >= required
    cells.push(
      <rect
        key={i}
        x={cx + 2}
        y={cy + 2}
        width={CELL - 6}
        height={CELL - 6}
        rx={2.5}
        fill={filled ? color : 'none'}
        fillOpacity={surplus ? 0.4 : 1}
        stroke={filled ? color : 'var(--muted-foreground)'}
        strokeWidth={1.1}
        strokeDasharray={filled ? undefined : '3 2'}
      />
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <SchematicCanvas viewW={viewW} viewH={viewH} minWidth={Math.min(viewW, 240)} label={check.label}>
        {cells}
      </SchematicCanvas>
    </div>
  )
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
      eyebrow="Schematic"
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

      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-foreground">{car.label}</p>
        <SlotGrid check={car} />
        <LimitBar check={car} />
      </div>

      {bike && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-foreground">{bike.label}</p>
          <SlotGrid check={bike} />
          <LimitBar check={bike} />
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Gefüllt = nachgewiesen{car.required != null ? `, gestrichelt = gefordert (${fmtNum(car.required)})` : ''}.
      </p>
    </SchematicCard>
  )
}
