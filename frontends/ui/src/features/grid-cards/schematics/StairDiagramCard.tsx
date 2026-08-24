/**
 * StairDiagramCard — a stair flight drawn to scale, section + plan, with the
 * OIB step-geometry checks (Steigung / Auftritt / Laufbreite) annotated.
 *
 * The section shows the true stepped profile (riser_count × rise/going), a
 * dashed pitch line with the architectural "n Stg r/g" notation, and one rise
 * + one going dimensioned on a middle step. Below it a plan strip (Grundriss)
 * shows the flight width to the same scale with the Lauflinie walking line
 * and the width dimension. Unknown values fall back to a neutral geometry for
 * the drawing only — their dimension arrows read "fehlende Angabe" in muted
 * dashed style, never a fabricated number.
 */

import { type FC } from 'react'
import { TrendingUp } from 'lucide-react'
import {
  DimChecksList,
  DimensionArrow,
  ExtensionLine,
  fitScale,
  fmtDim,
  fmtNum,
  SchematicCanvas,
  SchematicCard,
  SvgLabel,
  worstStatus,
} from './kit'
import { sketchPolygon, sketchRect, type Point } from './rough'
import { useTranslations } from '@/i18n'
import type { DimensionCheckData, NormReferenceData } from './types'

interface StairDiagramCardProps {
  title: string
  riser_count: number
  riser_height: DimensionCheckData
  tread_depth: DimensionCheckData
  width: DimensionCheckData
  comfort_note?: string | null
  reference?: NormReferenceData | null
}

/** Neutral drawing geometry when a value is unknown (labels stay "missing"). */
const FALLBACK_RISE_CM = 17.5
const FALLBACK_GOING_CM = 28
const FALLBACK_WIDTH_CM = 100

export const StairDiagramCard: FC<StairDiagramCardProps> = ({
  title,
  riser_count,
  riser_height,
  tread_depth,
  width,
  comfort_note,
  reference,
}) => {
  const t = useTranslations('chat')
  const n = Math.max(1, Math.min(riser_count, 30))
  const rise = riser_height.value ?? FALLBACK_RISE_CM
  const going = tread_depth.value ?? FALLBACK_GOING_CM
  const flightWidth = width.value ?? FALLBACK_WIDTH_CM

  const runC = n * going
  const riseC = n * rise
  const k = fitScale(runC, riseC, 384, 216)

  const padL = 78
  const padTop = 18
  const W = runC * k
  const H = riseC * k
  const baseY = padTop + H
  const X = (cm: number): number => padL + cm * k
  const Y = (cm: number): number => baseY - cm * k

  // Stepped profile polygon: up a riser, across a tread, n times; closed base.
  const profile: Point[] = [[X(0), Y(0)]]
  for (let i = 1; i <= n; i += 1) {
    profile.push([X((i - 1) * going), Y(i * rise)])
    profile.push([X(i * going), Y(i * rise)])
  }
  profile.push([X(n * going), Y(0)])

  // Pitch line through the nosings.
  const pitchX1 = X(0)
  const pitchY1 = Y(rise)
  const pitchX2 = X((n - 1) * going)
  const pitchY2 = Y(n * rise)
  const pitchAngle = (Math.atan2(pitchY2 - pitchY1, pitchX2 - pitchX1) * 180) / Math.PI
  const pitchMidX = (pitchX1 + pitchX2) / 2
  const pitchMidY = (pitchY1 + pitchY2) / 2
  const hasGeometry = riser_height.value != null && tread_depth.value != null
  const pitchNote = hasGeometry
    ? t('cards.schematics.stair.stepNotation', {
        count: n,
        rise: fmtNum(rise),
        going: fmtNum(going),
      })
    : t('cards.schematics.stair.stepCount', { count: n })

  // Dimension one rise + one going on a step in the lower quarter of the
  // flight, clear of the pitch-line notation that runs through the middle.
  const mid = Math.min(Math.max(Math.round(n / 4), 1), n)
  const riseX = X((mid - 1) * going) - 12
  const riseTop = Y(mid * rise)
  const riseBottom = Y((mid - 1) * rise)
  const goingY = Y(mid * rise) - 12
  const goingX1 = X((mid - 1) * going)
  const goingX2 = X(mid * going)

  // Plan strip (Grundriss) below the section, same scale.
  const planGap = 30
  const planTop = baseY + planGap
  const planH = flightWidth * k
  const planMidY = planTop + planH / 2
  const widthDimX = X(runC) + 16

  const viewW = padL + W + 68
  const viewH = planTop + planH + 22

  return (
    <SchematicCard
      icon={TrendingUp}
      title={title}
      verdict={worstStatus([riser_height.status, tread_depth.status, width.status])}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
        {/* section caption + stepped profile */}
        <SvgLabel x={padL} y={padTop - 8} size={8} weight={600}>
          {t('cards.schematics.stair.section')}
        </SvgLabel>
        {sketchPolygon(profile, 'stair-profile', {
          strokeWidth: 1.5,
          fill: 'color-mix(in oklch, var(--muted-foreground) 50%, transparent)',
          fillStyle: 'hachure',
          fillWeight: 0.5,
          hachureGap: 10,
          hachureAngle: -41,
        })}

        {/* pitch line with architectural step notation */}
        <line
          x1={pitchX1}
          y1={pitchY1}
          x2={pitchX2}
          y2={pitchY2}
          stroke="var(--muted-foreground)"
          strokeWidth={1}
          strokeDasharray="5 4"
          opacity={0.7}
        />
        <SvgLabel
          x={pitchMidX}
          y={pitchMidY - 11}
          anchor="middle"
          size={9}
          mono
          transform={`rotate(${pitchAngle} ${pitchMidX} ${pitchMidY - 11})`}
        >
          {pitchNote}
        </SvgLabel>

        {/* one rise, one going — measured on a middle step */}
        <ExtensionLine x1={X((mid - 1) * going)} y1={riseBottom} x2={riseX - 4} y2={riseBottom} />
        <ExtensionLine x1={X((mid - 1) * going)} y1={riseTop} x2={riseX - 4} y2={riseTop} />
        <DimensionArrow
          x1={riseX}
          y1={riseBottom}
          x2={riseX}
          y2={riseTop}
          label={fmtDim(riser_height.value, riser_height.unit ?? 'cm', t)}
          status={riser_height.status}
          labelOffset={-12}
          fontSize={9.5}
        />
        <ExtensionLine x1={goingX1} y1={Y(mid * rise)} x2={goingX1} y2={goingY - 4} />
        <ExtensionLine x1={goingX2} y1={Y(mid * rise)} x2={goingX2} y2={goingY - 4} />
        <DimensionArrow
          x1={goingX1}
          y1={goingY}
          x2={goingX2}
          y2={goingY}
          label={fmtDim(tread_depth.value, tread_depth.unit ?? 'cm', t)}
          status={tread_depth.status}
          labelOffset={-9}
          fontSize={9.5}
        />

        {/* plan strip: flight width to the same scale, with Lauflinie */}
        <SvgLabel x={padL} y={planTop - 8} size={8} weight={600}>
          {t('cards.schematics.stair.plan')}
        </SvgLabel>
        {sketchRect(X(0), planTop, W, planH, 'stair-plan', { strokeWidth: 1.2 })}
        {Array.from({ length: n - 1 }, (_, i) => (
          <line
            key={`tread-${i}`}
            x1={X((i + 1) * going)}
            y1={planTop}
            x2={X((i + 1) * going)}
            y2={planTop + planH}
            stroke="var(--muted-foreground)"
            strokeWidth={0.7}
            opacity={0.55}
          />
        ))}
        {/* Lauflinie: walking line with start circle and direction arrow */}
        <line
          x1={X(going * 0.6)}
          y1={planMidY}
          x2={X(runC - going * 0.6)}
          y2={planMidY}
          stroke="var(--muted-foreground)"
          strokeWidth={1}
          opacity={0.75}
        />
        <circle
          cx={X(going * 0.6)}
          cy={planMidY}
          r={2.6}
          fill="var(--muted-foreground)"
          opacity={0.75}
        />
        <path
          d={`M ${X(runC - going * 0.6) - 6} ${planMidY - 3.5} L ${X(runC - going * 0.6)} ${planMidY} L ${X(runC - going * 0.6) - 6} ${planMidY + 3.5}`}
          stroke="var(--muted-foreground)"
          strokeWidth={1}
          fill="none"
          opacity={0.75}
          strokeLinecap="round"
        />

        {/* flight width, measured on the plan */}
        <ExtensionLine x1={X(runC)} y1={planTop} x2={widthDimX + 4} y2={planTop} />
        <ExtensionLine
          x1={X(runC)}
          y1={planTop + planH}
          x2={widthDimX + 4}
          y2={planTop + planH}
        />
        <DimensionArrow
          x1={widthDimX}
          y1={planTop + planH}
          x2={widthDimX}
          y2={planTop}
          label={fmtDim(width.value, width.unit ?? 'cm', t)}
          status={width.status}
          labelOffset={13}
          fontSize={9.5}
        />
      </SchematicCanvas>

      <DimChecksList checks={[riser_height, tread_depth, width]} />

      {comfort_note && (
        <p className="max-w-prose text-xs italic leading-relaxed text-muted-foreground">
          {comfort_note}
        </p>
      )}
    </SchematicCard>
  )
}
