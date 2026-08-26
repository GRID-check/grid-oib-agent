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
 */

import { type FC } from 'react'
import { LandPlot } from 'lucide-react'
import { DimChecksList, fmtDim, fmtNum, SchematicCard, statusColor, worstStatus } from '../cards/shell'
import { DimensionArrow, fitScale, SchematicCanvas, SvgLabel } from './draw'
import { sketchRect } from './rough'
import { useTranslations, type Translator } from '@/i18n'
import type { DimensionCheckData, NormReferenceData, SetbackSideData } from './types'

interface SetbackPlanCardProps {
  title: string
  parcel_width_m: number
  parcel_depth_m: number
  building_width_m: number
  building_depth_m: number
  sides: SetbackSideData[]
  reference?: NormReferenceData | null
}

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

export const SetbackPlanCard: FC<SetbackPlanCardProps> = ({
  title,
  parcel_width_m: parcelW,
  parcel_depth_m: parcelD,
  building_width_m: buildingW,
  building_depth_m: buildingD,
  sides,
  reference,
}) => {
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
    <SchematicCard
      icon={LandPlot}
      title={title}
      verdict={worstStatus(sides.map((s) => s.status))}
      reference={reference}
    >
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

      {sides.some((s) => s.status === 'fail') && (
        <p className="text-xs font-medium" style={{ color: statusColor('fail') }}>
          {t('cards.schematics.setback.tooClose')}
        </p>
      )}
    </SchematicCard>
  )
}
