/**
 * DaylightIncidenceCard — OIB 3 Belichtung: the 45° free-light line in section.
 *
 * Draws a window wall in section (sill/head to scale), the 45° free-light
 * incidence line rising from the window's LOWER edge, and — if present — the
 * obstruction at its real distance/height. The renderer does the trigonometry:
 * at distance d the 45° line sits d metres above the sill, so an obstruction
 * pierces the light cone exactly when height > distance. The pierce verdict
 * colours the line + obstruction (pass green / grazing amber / fail red).
 * Below the drawing a LimitBar reads the Lichteintrittsfläche against the
 * ≥10 %-of-floor-area rule (required derived from the floor area when the
 * model left it null). Unknown sill/head fall back to neutral geometry, their
 * labels read "fehlende Angabe" — never a fabricated number.
 */

import { type FC } from 'react'
import { Sun } from 'lucide-react'
import {
  DimChecksList,
  DimensionArrow,
  ExtensionLine,
  fitScale,
  fmtDim,
  fmtNum,
  LimitBar,
  SchematicCanvas,
  SchematicCard,
  statusColor,
  SvgLabel,
  worstStatus,
} from './kit'
import { sketchLine, sketchRect } from './rough'
import { useTranslations } from '@/i18n'
import type { DimensionCheckData, DimStatus, NormReferenceData, ObstructionData } from './types'

interface DaylightIncidenceCardProps {
  title: string
  room_floor_area_m2?: number | null
  glass_area: DimensionCheckData
  window_sill_height_m?: number | null
  window_head_height_m?: number | null
  obstruction?: ObstructionData | null
  reference?: NormReferenceData | null
  note?: string | null
}

/** Neutral drawing geometry when a value is unknown (labels stay "missing"). */
const FALLBACK_SILL_M = 1.0
const FALLBACK_HEAD_M = 2.4

export const DaylightIncidenceCard: FC<DaylightIncidenceCardProps> = ({
  title,
  room_floor_area_m2: floorArea,
  glass_area,
  window_sill_height_m,
  window_head_height_m,
  obstruction,
  reference,
  note,
}) => {
  const t = useTranslations('chat')
  const sill = window_sill_height_m ?? FALLBACK_SILL_M
  const head = Math.max(window_head_height_m ?? FALLBACK_HEAD_M, sill + 0.4)

  // 45° free-light geometry — renderer-computed, never model-supplied:
  // at horizontal distance x the line is x metres above the sill, so an
  // obstruction pierces the cone exactly when height_m > distance_m.
  const obsD = obstruction?.distance_m ?? null
  const obsH = obstruction?.height_m ?? null
  const lightStatus: DimStatus | null =
    obsD != null && obsH != null
      ? obsH > obsD
        ? 'fail'
        : obsH >= obsD * 0.9
          ? 'warning'
          : 'pass'
      : null
  const lightColor = lightStatus
    ? statusColor(lightStatus)
    : 'var(--text-color-feedback-info)'

  // Horizontal extent (m): far enough to include the obstruction, else a
  // neutral 4 m stretch of open sky.
  const extentM = obsD != null ? obsD + Math.max(1, obsD * 0.2) : 4
  const obsTopM = obsH != null ? sill + obsH : 0
  const totalHm = Math.max(head, obsTopM, sill + Math.min(extentM, 2.6)) + 0.7
  const wallT = 0.32

  const k = fitScale(wallT + extentM, totalHm, 316, 206)
  const padL = 84
  const padTop = 18
  const baseY = padTop + totalHm * k
  const wallX = padL
  const wallW = wallT * k
  const faceX = wallX + wallW
  const X = (m: number): number => faceX + m * k
  const Y = (m: number): number => baseY - m * k

  // 45° line clipped at the drawing top / right edge, whichever comes first.
  const lightEndM = Math.min(extentM, totalHm - sill - 0.15)

  const glassCheck: DimensionCheckData = {
    ...glass_area,
    label: glass_area.label || t('cards.schematics.daylight.glassArea'),
    unit: glass_area.unit ?? 'm²',
    // ≥10 % of the floor area is arithmetic on provided data, not a guess —
    // derive the required area when the model left it null.
    required:
      glass_area.required ?? (floorArea != null ? Math.round(floorArea * 10) / 100 : null),
    comparator: glass_area.comparator ?? '>=',
  }

  const checks: DimensionCheckData[] = [glassCheck]
  if (obstruction && lightStatus) {
    checks.push({
      label: t('cards.schematics.daylight.obstruction', { label: obstruction.label }),
      value: obsH,
      required: obsD,
      unit: 'm',
      comparator: '<=',
      status: lightStatus,
    })
  }

  const viewW = padL + wallW + extentM * k + 56
  const viewH = baseY + 26

  return (
    <SchematicCard
      icon={Sun}
      title={title}
      verdict={worstStatus(checks.map((c) => c.status))}
      note={note}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
        {/* ground line with hatch ticks */}
        {sketchLine(wallX - 22, baseY, X(extentM) + 18, baseY, 'daylight-ground', {
          strokeWidth: 1.6,
        })}
        {Array.from({ length: 9 }, (_, i) => {
          const gx = wallX - 16 + i * ((X(extentM) + 26 - wallX) / 9)
          return (
            <line
              key={`hatch-${i}`}
              x1={gx}
              y1={baseY}
              x2={gx - 5}
              y2={baseY + 6}
              stroke="var(--muted-foreground)"
              strokeWidth={0.8}
              opacity={0.55}
            />
          )
        })}

        {/* window wall in section: parapet below the sill, lintel above the head */}
        {sketchRect(wallX, Y(sill), wallW, sill * k, 'daylight-parapet', {
          strokeWidth: 1.4,
          fill: 'color-mix(in oklch, var(--muted-foreground) 50%, transparent)',
          fillStyle: 'hachure',
          fillWeight: 0.5,
          hachureGap: 6,
        })}
        {/* lintel: a capped stub above the head, not a tower to the canvas top */}
        {sketchRect(wallX, Y(Math.min(head + 0.6, totalHm - 0.1)), wallW, Y(head) - Y(Math.min(head + 0.6, totalHm - 0.1)), 'daylight-lintel', {
          strokeWidth: 1.4,
          fill: 'color-mix(in oklch, var(--muted-foreground) 50%, transparent)',
          fillStyle: 'hachure',
          fillWeight: 0.5,
          hachureGap: 6,
        })}
        {/* break line hinting the wall continues */}
        <line
          x1={wallX - 4}
          y1={Y(Math.min(head + 0.6, totalHm - 0.1)) - 3}
          x2={wallX + wallW + 4}
          y2={Y(Math.min(head + 0.6, totalHm - 0.1)) - 9}
          stroke="var(--muted-foreground)"
          strokeWidth={0.9}
          opacity={0.6}
        />
        {/* glazing in the opening */}
        <line
          x1={wallX + wallW / 2}
          y1={Y(sill)}
          x2={wallX + wallW / 2}
          y2={Y(head)}
          stroke="var(--text-color-feedback-info)"
          strokeWidth={1.6}
        />
        <SvgLabel
          x={wallX + wallW / 2}
          y={Y((sill + head) / 2)}
          anchor="middle"
          size={8}
          transform={`rotate(-90 ${wallX + wallW / 2} ${Y((sill + head) / 2)})`}
        >
          {t('cards.schematics.daylight.window')}
        </SvgLabel>

        {/* sill + head heights, measured left of the wall */}
        <ExtensionLine x1={wallX} y1={Y(sill)} x2={wallX - 30} y2={Y(sill)} />
        <ExtensionLine x1={wallX} y1={baseY} x2={wallX - 30} y2={baseY} />
        <DimensionArrow
          x1={wallX - 26}
          y1={baseY}
          x2={wallX - 26}
          y2={Y(sill)}
          label={fmtDim(window_sill_height_m, 'm', t)}
          status={window_sill_height_m == null ? 'needs_input' : undefined}
          color={window_sill_height_m == null ? undefined : 'var(--muted-foreground)'}
          labelOffset={-13}
          fontSize={9}
        />
        <ExtensionLine x1={wallX} y1={Y(head)} x2={wallX - 58} y2={Y(head)} />
        <DimensionArrow
          x1={wallX - 54}
          y1={baseY}
          x2={wallX - 54}
          y2={Y(head)}
          label={fmtDim(window_head_height_m, 'm', t)}
          status={window_head_height_m == null ? 'needs_input' : undefined}
          color={window_head_height_m == null ? undefined : 'var(--muted-foreground)'}
          labelOffset={-13}
          fontSize={9}
        />

        {/* 45° free-light line from the window's LOWER edge */}
        <line
          x1={faceX}
          y1={Y(sill)}
          x2={X(lightEndM)}
          y2={Y(sill + lightEndM)}
          stroke={lightColor}
          strokeWidth={1.5}
          strokeDasharray="7 5"
        />
        {/* angle arc + label at the origin */}
        <path
          d={`M ${X(0.55)} ${Y(sill)} A ${0.55 * k} ${0.55 * k} 0 0 0 ${X(0.55 * Math.SQRT1_2)} ${Y(sill + 0.55 * Math.SQRT1_2)}`}
          stroke={lightColor}
          strokeWidth={1}
          fill="none"
          opacity={0.8}
        />
        <SvgLabel x={X(0.8)} y={Y(sill + 0.3)} size={9} mono fill={lightColor} weight={600}>
          45°
        </SvgLabel>
        {/* sill-level reference out to the obstruction */}
        <line
          x1={faceX}
          y1={Y(sill)}
          x2={X(extentM)}
          y2={Y(sill)}
          stroke="var(--muted-foreground)"
          strokeWidth={0.7}
          strokeDasharray="3 4"
          opacity={0.55}
        />

        {obstruction && obsD != null && obsH != null && (
          <g>
            {/* obstruction body, standing on the ground, top measured above the sill */}
            {sketchRect(
              X(obsD),
              Y(sill + obsH),
              Math.max((extentM - obsD) * k, 14),
              baseY - Y(sill + obsH),
              'daylight-obstruction',
              {
                strokeWidth: 1.4,
                stroke: statusColor(lightStatus ?? 'warning'),
                fill: 'color-mix(in oklch, var(--foreground) 30%, transparent)',
                fillStyle: 'hachure',
                fillWeight: 0.5,
                hachureGap: 8,
              }
            )}
            <SvgLabel
              x={Math.min(X(obsD) + 6, viewW - 10)}
              y={Y(sill + obsH) - 9}
              anchor="end"
              size={8.5}
              fill="var(--foreground)"
              weight={600}
            >
              {obstruction.label}
            </SvgLabel>

            {/* horizontal distance, measured at sill level */}
            <DimensionArrow
              x1={faceX}
              y1={baseY - 12}
              x2={X(obsD)}
              y2={baseY - 12}
              label={fmtDim(obsD, 'm', t)}
              color="var(--muted-foreground)"
              labelOffset={-9}
              fontSize={9}
            />
            {/* obstruction height above the sill */}
            <ExtensionLine x1={X(obsD)} y1={Y(sill + obsH)} x2={X(obsD) - 14} y2={Y(sill + obsH)} />
            <DimensionArrow
              x1={X(obsD) - 10}
              y1={Y(sill)}
              x2={X(obsD) - 10}
              y2={Y(sill + obsH)}
              label={fmtDim(obsH, 'm', t)}
              status={lightStatus}
              labelOffset={-12}
              fontSize={9}
            />
          </g>
        )}
      </SchematicCanvas>

      <LimitBar check={glassCheck} />

      {floorArea != null && (
        <p className="text-xs text-muted-foreground">
          {t('cards.schematics.daylight.requiredArea', {
            floor: fmtNum(floorArea),
            required: fmtNum(Math.round(floorArea * 10) / 100),
          })}
        </p>
      )}

      <DimChecksList checks={checks} />

      {lightStatus === 'fail' && (
        <p className="text-xs font-medium" style={{ color: statusColor('fail') }}>
          {t('cards.schematics.daylight.obstructionPierces')}
        </p>
      )}
    </SchematicCard>
  )
}
