/**
 * EnergyPerformanceCard — Energieausweis: the Heizwärmebedarf placed on the
 * A++…G energy-class ladder, with a limit bar reading HWB vs the maximum.
 *
 * The ladder is the familiar EU-style stepped label (green A++ → red G); the
 * building's class row gets a pointer marker carrying its HWB value. Below, a
 * LimitBar reads the Heizwärmebedarf against the required maximum (lower is
 * better) and, when supplied, the Gesamtenergieeffizienzfaktor (fGEE). The
 * ladder colours are the conventional fixed energy-label palette.
 */

import { type FC } from 'react'
import { Gauge } from 'lucide-react'
import {
  fmtDim,
  LimitBar,
  MISSING_LABEL,
  SchematicCanvas,
  SchematicCard,
  SvgLabel,
} from './kit'
import type { DimensionCheckData, NormReferenceData } from './types'

interface EnergyPerformanceCardProps {
  title: string
  hwb: DimensionCheckData
  energy_class?: string | null
  fgee?: DimensionCheckData | null
  reference?: NormReferenceData | null
  note?: string | null
}

/** Conventional energy-label bands, best → worst (fixed palette by convention). */
const CLASSES: { label: string; color: string }[] = [
  { label: 'A++', color: '#1a9641' },
  { label: 'A+', color: '#4cae4c' },
  { label: 'A', color: '#7fbf3f' },
  { label: 'B', color: '#c3d92f' },
  { label: 'C', color: '#f4d03f' },
  { label: 'D', color: '#f5b041' },
  { label: 'E', color: '#eb8f34' },
  { label: 'F', color: '#e2662c' },
  { label: 'G', color: '#d0021b' },
]

const normClass = (c: string): string => c.trim().toUpperCase().replace(/\s+/g, '')

export const EnergyPerformanceCard: FC<EnergyPerformanceCardProps> = ({
  title,
  hwb,
  energy_class: energyClass,
  fgee,
  reference,
  note,
}) => {
  const activeIndex = energyClass
    ? CLASSES.findIndex((c) => c.label === normClass(energyClass))
    : -1

  const rowH = 15
  const gap = 3
  const x0 = 18
  const baseW = 74
  const stepW = 12
  const viewW = 300
  const viewH = CLASSES.length * (rowH + gap) + 14

  const hwbCheck: DimensionCheckData = {
    ...hwb,
    label: hwb.label || 'Heizwärmebedarf (HWB)',
    unit: hwb.unit ?? 'kWh/m²a',
    comparator: hwb.comparator ?? '<=',
  }

  return (
    <SchematicCard
      icon={Gauge}
      eyebrow="Schematic"
      title={title}
      verdict={hwbCheck.status}
      note={note}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} minWidth={300} label={title}>
        {CLASSES.map((cls, i) => {
          const y = 7 + i * (rowH + gap)
          const w = baseW + i * stepW
          const active = i === activeIndex
          return (
            <g key={cls.label}>
              {/* stepped bar with an arrow tip */}
              <path
                d={`M ${x0} ${y} H ${x0 + w} L ${x0 + w + 9} ${y + rowH / 2} L ${x0 + w} ${y + rowH} H ${x0} Z`}
                fill={cls.color}
                opacity={active || activeIndex < 0 ? 1 : 0.4}
              />
              <text
                x={x0 + 9}
                y={y + rowH / 2}
                dominantBaseline="central"
                fontSize={10}
                fontWeight={700}
                fontFamily="var(--font-sans)"
                fill="#fff"
              >
                {cls.label}
              </text>
              {active && (
                <g>
                  <rect
                    x={x0 + w + 16}
                    y={y - 1}
                    width={118}
                    height={rowH + 2}
                    rx={3}
                    fill="var(--card)"
                    stroke={cls.color}
                    strokeWidth={1.6}
                  />
                  <SvgLabel
                    x={x0 + w + 24}
                    y={y + rowH / 2}
                    size={9.5}
                    weight={700}
                    fill="var(--foreground)"
                    halo="var(--card)"
                  >
                    {hwbCheck.value != null
                      ? `HWB ${fmtDim(hwbCheck.value, hwbCheck.unit ?? '')}`
                      : MISSING_LABEL}
                  </SvgLabel>
                </g>
              )}
            </g>
          )
        })}
      </SchematicCanvas>

      <div className="flex flex-col gap-2.5">
        <LimitBar check={hwbCheck} />
        {fgee && (
          <LimitBar
            check={{
              ...fgee,
              label: fgee.label || 'Gesamtenergieeffizienzfaktor (fGEE)',
              unit: fgee.unit ?? '',
              comparator: fgee.comparator ?? '<=',
            }}
          />
        )}
      </div>
    </SchematicCard>
  )
}
