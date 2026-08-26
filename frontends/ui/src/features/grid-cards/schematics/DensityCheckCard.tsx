/**
 * DensityCheckCard — Bebauungsdichte: parcel + shaded footprint + two bars.
 *
 * The parcel is drawn as a square-ish box whose AREA is to scale (side =
 * √area at a fixed 4:3 aspect), with the footprint shaded inside at its true
 * area ratio — so a 25 % Bebauungsgrad visibly covers a quarter of the box.
 * Below, two LimitBars read coverage (bebaute Fläche / Grundstück) and
 * density (BGF / Grundstück, GFZ) against the Bebauungsplan limits. The
 * renderer computes the ratios from the areas — when a ratio value is null it
 * is derived from the *_area_m2 fields (arithmetic, not a guess); when the
 * areas are missing too, the bar reads "fehlende Angabe".
 */

import { type FC } from 'react'
import { Grid2x2 } from 'lucide-react'
import { fmtNum, LimitBar, missingLabel, SchematicCard, statusColor, worstStatus } from '../cards/shell'
import { fitScale, SchematicCanvas, SvgLabel } from './draw'
import { sketchRect } from './rough'
import { useTranslations } from '@/i18n'
import type { DimensionCheckData, NormReferenceData } from './types'

interface DensityCheckCardProps {
  title: string
  parcel_area_m2: number
  footprint_area_m2?: number | null
  gross_floor_area_m2?: number | null
  coverage: DimensionCheckData
  density: DimensionCheckData
  reference?: NormReferenceData | null
  note?: string | null
}

/**
 * Fill in a ratio check the renderer can compute: derive the value from
 * numerator/parcel when the model left it null (percent for coverage-style
 * checks, plain ratio for GFZ-style), and settle a needs_input status once a
 * value + limit are both known.
 */
const deriveRatio = (
  check: DimensionCheckData,
  fallbackLabel: string,
  numerator: number | null | undefined,
  parcelArea: number,
  preferPercent: boolean
): DimensionCheckData => {
  let value = check.value ?? null
  let unit = check.unit
  if (value == null && numerator != null && parcelArea > 0) {
    const asPercent = unit === '%' || (unit == null && preferPercent)
    const ratio = numerator / parcelArea
    value = asPercent ? Math.round(ratio * 1000) / 10 : Math.round(ratio * 100) / 100
    unit = unit ?? (asPercent ? '%' : '')
  }
  let status = check.status
  if (value == null) {
    status = 'needs_input'
  } else if (status === 'needs_input' && check.required != null) {
    const ok = check.comparator === '>=' ? value >= check.required : value <= check.required
    status = ok ? 'pass' : 'fail'
  }
  return {
    ...check,
    label: check.label || fallbackLabel,
    value,
    unit: unit ?? (preferPercent ? '%' : ''),
    comparator: check.comparator ?? '<=',
    status,
  }
}

export const DensityCheckCard: FC<DensityCheckCardProps> = ({
  title,
  parcel_area_m2: parcelArea,
  footprint_area_m2: footprintArea,
  gross_floor_area_m2: grossFloorArea,
  coverage,
  density,
  reference,
  note,
}) => {
  const t = useTranslations('chat')
  const coverageCheck = deriveRatio(
    coverage,
    t('cards.schematics.density.coverage'),
    footprintArea,
    parcelArea,
    true
  )
  const densityCheck = deriveRatio(density, 'GFZ', grossFloorArea, parcelArea, false)

  // Parcel box: area-true square-ish rectangle at 4:3, kept compact — the
  // drawing carries one fact (the area ratio), it should not dominate the card.
  const parcelWm = Math.sqrt((parcelArea * 4) / 3)
  const parcelDm = parcelArea / parcelWm
  const k = fitScale(parcelWm, parcelDm, 220, 148)
  const px = 24
  const py = 24
  const PW = parcelWm * k
  const PD = parcelDm * k

  // Footprint shading: side ratio √(footprint/parcel) keeps the AREA ratio true.
  const footRatio =
    footprintArea != null && parcelArea > 0
      ? Math.min(Math.sqrt(footprintArea / parcelArea), 1)
      : null
  const FW = (footRatio ?? 0.5) * PW
  const FD = (footRatio ?? 0.5) * PD
  const fx = px + PW * 0.18
  const fy = py + PD - FD - PD * 0.14
  const fMidX = fx + FW / 2
  const fMidY = fy + FD / 2

  const viewW = px + PW + 24
  const viewH = py + PD + 30

  return (
    <SchematicCard
      icon={Grid2x2}
      title={title}
      verdict={worstStatus([coverageCheck.status, densityCheck.status])}
      note={note}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
        {/* parcel, area to scale */}
        {sketchRect(px, py, PW, PD, 'density-parcel', { strokeWidth: 1.5 })}
        <SvgLabel x={px} y={py - 11} size={9}>
          {t('cards.schematics.density.parcel', { area: fmtNum(parcelArea) })}
        </SvgLabel>

        {/* footprint, area ratio to scale — dashed placeholder when unknown */}
        {footRatio != null ? (
          <g>
            {sketchRect(fx, fy, FW, FD, 'density-footprint', {
              strokeWidth: 1.4,
              fill: 'color-mix(in oklch, var(--foreground) 40%, transparent)',
              fillStyle: 'hachure',
              fillWeight: 0.5,
              hachureGap: 7,
            })}
            <SvgLabel
              x={fMidX}
              y={fMidY - 6}
              anchor="middle"
              weight={600}
              fill="var(--foreground)"
              size={9.5}
            >
              {t('cards.schematics.density.builtUp')}
            </SvgLabel>
            <SvgLabel x={fMidX} y={fMidY + 7} anchor="middle" mono size={8.5}>
              {fmtNum(footprintArea ?? 0)} m²
            </SvgLabel>
            {coverageCheck.value != null && (
              <SvgLabel
                x={fMidX}
                y={fMidY + 19}
                anchor="middle"
                mono
                size={8.5}
                weight={600}
                fill={statusColor(coverageCheck.status)}
              >
                {fmtNum(coverageCheck.value)} {coverageCheck.unit}
              </SvgLabel>
            )}
          </g>
        ) : (
          <g>
            <rect
              x={fx}
              y={fy}
              width={FW}
              height={FD}
              fill="none"
              stroke="var(--muted-foreground)"
              strokeWidth={1}
              strokeDasharray="5 4"
            />
            <SvgLabel x={fMidX} y={fMidY} anchor="middle" italic size={8.5}>
              {t('cards.schematics.density.builtUpUnknown', { missing: missingLabel(t) })}
            </SvgLabel>
          </g>
        )}
      </SchematicCanvas>

      {grossFloorArea != null && (
        <p className="text-xs text-muted-foreground">
          {t('cards.schematics.density.grossFloorArea')}:{' '}
          <span className="font-mono text-foreground">{fmtNum(grossFloorArea)} m²</span>
        </p>
      )}

      <LimitBar check={coverageCheck} />
      <LimitBar check={densityCheck} />
    </SchematicCard>
  )
}
