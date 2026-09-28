/**
 * SetbackPlanCard — top-down site plan for Abstandsflächen / Bauwich checks.
 *
 * Draws the parcel to scale, the required-setback envelope (Baufenster) as a
 * dashed inset — each edge inset by that side's required distance — and the
 * building footprint placed from the actual side distances (centered on an
 * axis when both actuals are unknown). Every side gets a status-coloured
 * dimension arrow at its midpoint; a failing side turns its envelope edge red
 * as well, so the violated line is unmissable. A street band anchors "front"
 * at the bottom and a north arrow orients the plan.
 *
 * Under the plan, where `coverage` or `density` is given, a readout of
 * Bebauungsgrad (built area / parcel) and GFZ (BGF / parcel) against the
 * Bebauungsplan's limits: the retired `density_check` card's job. The ratios
 * are COMPUTED here from the areas ({@link densityReadout}) and the computation
 * wins: a ratio the model stated is shown only where no areas give one, and a
 * stated ratio that disagrees with the areas is named beside the computed one.
 * A pure density question (no parcel geometry, `sides` empty) draws the
 * readout and no plan: a parcel nobody gave is never drawn to scale.
 */

import { type FC } from 'react'
import { LandPlot } from 'lucide-react'
import {
  DimChecksList,
  DimensionArrow,
  fitScale,
  fmtDim,
  fmtNum,
  SchematicCanvas,
  SchematicCard,
  statusColor,
  SvgLabel,
  worstStatus,
} from './kit'
import { sketchRect } from './rough'
import { useTranslations, type Translator } from '@/i18n'
import type { DimensionCheckData, NormReferenceData, SetbackSideData } from './types'

interface SetbackPlanCardProps {
  title: string
  parcel_width_m?: number | null
  parcel_depth_m?: number | null
  building_width_m?: number | null
  building_depth_m?: number | null
  sides: SetbackSideData[]
  reference?: NormReferenceData | null
  parcel_area_m2?: number | null
  footprint_area_m2?: number | null
  gross_floor_area_m2?: number | null
  coverage?: DimensionCheckData | null
  density?: DimensionCheckData | null
}

/** How far a stated ratio may sit from the computed one and still be the same figure (rounding). */
const RATIO_TOLERANCE = 0.01

/**
 * A ratio's check with its value derived from two areas. Where the areas give
 * one, the computation wins over a value the model typed (guardrail 1): an
 * agreeing value is kept, a disagreeing one is named in the label
 * (`stated`) beside the computed value and status.
 */
function derivedRatio(
  check: DimensionCheckData,
  numerator: number | null,
  denominator: number | null,
  stated: (value: number) => string
): DimensionCheckData {
  if (numerator == null || denominator == null || !(denominator > 0)) {
    return check.value != null ? check : { ...check, status: 'needs_input' }
  }
  const ratio = numerator / denominator
  const value = Math.round((check.unit === '%' ? ratio * 100 : ratio) * 100) / 100
  const disagrees = check.value != null && Math.abs(check.value - value) > Math.max(RATIO_TOLERANCE, Math.abs(value) * RATIO_TOLERANCE)
  const label = disagrees && check.value != null ? `${check.label} (${stated(check.value)})` : check.label
  if (check.required == null) return { ...check, label, value }
  // A density limit is a ceiling unless the Bebauungsplan says otherwise.
  const pass = check.comparator === '>=' ? value >= check.required : value <= check.required
  return { ...check, label, value, status: pass ? 'pass' : 'fail' }
}

/** Bebauungsgrad and GFZ, derived from the areas wherever they are given. */
export function densityReadout({
  parcelArea,
  footprintArea,
  grossFloorArea,
  coverage,
  density,
  stated = (value) => String(value),
}: {
  parcelArea: number | null
  footprintArea: number | null
  grossFloorArea: number | null
  coverage?: DimensionCheckData | null
  density?: DimensionCheckData | null
  /** A stated ratio that disagrees with the areas, as the label names it. */
  stated?: (value: number) => string
}): DimensionCheckData[] {
  return [
    ...(coverage ? [derivedRatio(coverage, footprintArea, parcelArea, stated)] : []),
    ...(density ? [derivedRatio(density, grossFloorArea, parcelArea, stated)] : []),
  ]
}

const product = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a != null && b != null ? a * b : null

const sideName = (side: SetbackSideData['side'], t: Translator): string => {
  switch (side) {
    case 'front':
      return t('cards.schematics.setback.side.front')
    case 'back':
      return t('cards.schematics.setback.side.back')
    case 'left':
      return t('cards.schematics.setback.side.left')
    case 'right':
      return t('cards.schematics.setback.side.right')
  }
}

export const SetbackPlanCard: FC<SetbackPlanCardProps> = (props) => {
  const { title, sides, reference, coverage, density } = props
  const t = useTranslations('chat')
  const readout = densityReadout({
    parcelArea: props.parcel_area_m2 ?? product(props.parcel_width_m, props.parcel_depth_m),
    footprintArea: props.footprint_area_m2 ?? product(props.building_width_m, props.building_depth_m),
    grossFloorArea: props.gross_floor_area_m2 ?? null,
    coverage,
    density,
    stated: (value) => t('cards.schematics.setback.stated', { value: fmtNum(value) }),
  })
  // The card's verdict is every check it draws, the density readout included.
  const verdict = worstStatus([...sides.map((s) => s.status), ...readout.map((check) => check.status)])
  const { parcel_width_m: parcelW, parcel_depth_m: parcelD, building_width_m: buildingW, building_depth_m: buildingD } = props
  const drawable = parcelW != null && parcelD != null && buildingW != null && buildingD != null
  return (
    <SchematicCard icon={LandPlot} title={title} verdict={verdict} reference={reference}>
      {drawable && (
        <SetbackPlanDrawing
          title={title}
          sides={sides}
          parcelW={parcelW}
          parcelD={parcelD}
          buildingW={buildingW}
          buildingD={buildingD}
        />
      )}
      {readout.length > 0 && <DimChecksList checks={readout} className={drawable ? 'border-t pt-2' : undefined} />}
      {sides.some((s) => s.status === 'fail') && (
        <p className="text-xs font-medium" style={{ color: statusColor('fail') }}>
          {t('cards.schematics.setback.tooClose')}
        </p>
      )}
    </SchematicCard>
  )
}

/** The plan to scale, and the setback checks under it. */
const SetbackPlanDrawing: FC<{
  title: string
  sides: SetbackSideData[]
  parcelW: number
  parcelD: number
  buildingW: number
  buildingD: number
}> = ({ title, sides, parcelW, parcelD, buildingW, buildingD }) => {
  const t = useTranslations('chat')
  const side = (name: SetbackSideData['side']): SetbackSideData | undefined =>
    sides.find((s) => s.side === name)
  const left = side('left')
  const right = side('right')
  const front = side('front')
  const back = side('back')

  const k = fitScale(parcelW, parcelD, 300, 232)
  const px = 66
  const py = 26
  const PW = parcelW * k
  const PD = parcelD * k

  // Building placement in metres (front = bottom edge of the plan). Falls back
  // to centering on an axis when neither actual distance is known.
  const bxM =
    left?.actual_m ??
    (right?.actual_m != null ? parcelW - buildingW - right.actual_m : (parcelW - buildingW) / 2)
  const byM =
    back?.actual_m ??
    (front?.actual_m != null ? parcelD - buildingD - front.actual_m : (parcelD - buildingD) / 2)
  const bx = px + bxM * k
  const by = py + byM * k
  const BW = buildingW * k
  const BD = buildingD * k
  const bMidX = bx + BW / 2
  const bMidY = by + BD / 2

  // Required-setback envelope (Baufenster).
  const ex = px + (left?.required_m ?? 0) * k
  const ey = py + (back?.required_m ?? 0) * k
  const ew = PW - ((left?.required_m ?? 0) + (right?.required_m ?? 0)) * k
  const eh = PD - ((back?.required_m ?? 0) + (front?.required_m ?? 0)) * k

  const edgeColor = (s: SetbackSideData | undefined): string =>
    s?.status === 'fail'
      ? 'var(--text-color-feedback-danger)'
      : 'var(--text-color-feedback-info)'
  const edgeWidth = (s: SetbackSideData | undefined): number => (s?.status === 'fail' ? 1.6 : 1)

  const streetY = py + PD + 12
  const viewW = px + PW + 76
  const viewH = streetY + 26

  const checks: DimensionCheckData[] = sides.map((s) => ({
    label: t('cards.schematics.setback.distance', { side: sideName(s.side, t) }),
    value: s.actual_m,
    required: s.required_m,
    unit: 'm',
    comparator: '>=',
    status: s.status,
  }))

  return (
    <>
      <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
        {/* parcel */}
        {sketchRect(px, py, PW, PD, 'parcel', { strokeWidth: 1.5 })}
        <SvgLabel x={px} y={py - 11} size={9}>
          {t('cards.schematics.setback.parcel', {
            width: fmtNum(parcelW),
            depth: fmtNum(parcelD),
          })}
        </SvgLabel>

        {/* required-setback envelope, one edge per side */}
        {ew > 0 && eh > 0 && (
          <g strokeDasharray="6 4">
            <line x1={ex} y1={ey} x2={ex} y2={ey + eh} stroke={edgeColor(left)} strokeWidth={edgeWidth(left)} />
            <line x1={ex + ew} y1={ey} x2={ex + ew} y2={ey + eh} stroke={edgeColor(right)} strokeWidth={edgeWidth(right)} />
            <line x1={ex} y1={ey} x2={ex + ew} y2={ey} stroke={edgeColor(back)} strokeWidth={edgeWidth(back)} />
            <line x1={ex} y1={ey + eh} x2={ex + ew} y2={ey + eh} stroke={edgeColor(front)} strokeWidth={edgeWidth(front)} />
          </g>
        )}

        {/* building footprint */}
        {sketchRect(bx, by, BW, BD, 'building-footprint', {
          strokeWidth: 1.4,
          fill: 'color-mix(in oklch, var(--foreground) 40%, transparent)',
          fillStyle: 'hachure',
          fillWeight: 0.5,
          hachureGap: 7,
        })}
        <SvgLabel
          x={bMidX}
          y={bMidY - 6}
          anchor="middle"
          weight={600}
          fill="var(--foreground)"
          size={9.5}
        >
          {t('cards.schematics.setback.building')}
        </SvgLabel>
        <SvgLabel x={bMidX} y={bMidY + 7} anchor="middle" mono size={8.5}>
          {fmtNum(buildingW)} × {fmtNum(buildingD)} m
        </SvgLabel>

        {/* actual distance per side, measured at the side's midpoint */}
        {left && (
          <DimensionArrow
            x1={px}
            y1={bMidY}
            x2={bx}
            y2={bMidY}
            label={fmtDim(left.actual_m, 'm', t)}
            status={left.status}
            labelOffset={-10}
            fontSize={9}
          />
        )}
        {right && (
          <DimensionArrow
            x1={bx + BW}
            y1={bMidY}
            x2={px + PW}
            y2={bMidY}
            label={fmtDim(right.actual_m, 'm', t)}
            status={right.status}
            labelOffset={-10}
            fontSize={9}
          />
        )}
        {back && (
          <DimensionArrow
            x1={bMidX}
            y1={py}
            x2={bMidX}
            y2={by}
            label={fmtDim(back.actual_m, 'm', t)}
            status={back.status}
            labelOffset={back.actual_m == null ? -14 : -12}
            fontSize={9}
            horizontalLabel={back.actual_m == null}
          />
        )}
        {front && (
          <DimensionArrow
            x1={bMidX}
            y1={by + BD}
            x2={bMidX}
            y2={py + PD}
            label={fmtDim(front.actual_m, 'm', t)}
            status={front.status}
            labelOffset={front.actual_m == null ? -14 : -12}
            fontSize={9}
            horizontalLabel={front.actual_m == null}
          />
        )}

        {/* street band anchoring the front side */}
        <line x1={px - 14} y1={streetY} x2={px + PW + 14} y2={streetY} stroke="var(--muted-foreground)" strokeWidth={0.9} opacity={0.6} />
        <line x1={px - 14} y1={streetY + 10} x2={px + PW + 14} y2={streetY + 10} stroke="var(--muted-foreground)" strokeWidth={0.9} opacity={0.6} />
        <SvgLabel x={px + PW / 2} y={streetY + 5} anchor="middle" size={8} weight={600}>
          {t('cards.schematics.setback.street')}
        </SvgLabel>

        {/* north arrow */}
        <g opacity={0.75}>
          <line
            x1={px + PW + 40}
            y1={py + 26}
            x2={px + PW + 40}
            y2={py + 6}
            stroke="var(--muted-foreground)"
            strokeWidth={1}
          />
          <path
            d={`M ${px + PW + 36.5} ${py + 12} L ${px + PW + 40} ${py + 5} L ${px + PW + 43.5} ${py + 12}`}
            stroke="var(--muted-foreground)"
            strokeWidth={1}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <SvgLabel x={px + PW + 40} y={py + 36} anchor="middle" size={9} weight={600}>
            N
          </SvgLabel>
        </g>
      </SchematicCanvas>

      <DimChecksList checks={checks} />
    </>
  )
}
