/**
 * GuardrailCheckCard — OIB 4 Absturzsicherung: a railing elevation to scale.
 *
 * Front elevation of the railing: two posts, a top rail, and explicit vertical
 * balusters spaced at the ACTUAL max opening, so a wide opening is visibly
 * wide and the opening arrow measures a real gap between two bars. Dimension
 * arrows read rail height, max opening and bottom gap, each coloured by its
 * check status. The ~15–60 cm no-climb band (Kletterschutzbereich) is shaded —
 * danger-tinted when the model reports climbable horizontals inside it. Below
 * the deck a dashed break + arrow surfaces the Absturzhöhe, because it decides
 * whether 100 cm or 110 cm applies; the applicable minimum is echoed next to
 * it. Unknown values render as "fehlende Angabe", never a guessed number.
 */

import { type FC } from 'react'
import { Fence } from 'lucide-react'
import {
  DimChecksList,
  DimensionArrow,
  ExtensionLine,
  fitScale,
  fmtDim,
  SchematicCanvas,
  SchematicCard,
  statusColor,
  SvgLabel,
  worstStatus,
} from './kit'
import { sketchLine, sketchRect } from './rough'
import type { DimensionCheckData, NormReferenceData } from './types'

interface GuardrailCheckCardProps {
  title: string
  context: 'balkon' | 'loggia' | 'stiege' | 'fenster' | 'dachterrasse'
  fall_height: DimensionCheckData
  rail_height: DimensionCheckData
  max_opening: DimensionCheckData
  bottom_gap?: DimensionCheckData | null
  has_horizontal_elements_in_climb_zone?: boolean | null
  reference?: NormReferenceData | null
  note?: string | null
}

const CONTEXT_LABEL: Record<GuardrailCheckCardProps['context'], string> = {
  balkon: 'Balkon',
  loggia: 'Loggia',
  stiege: 'Stiege',
  fenster: 'Fenster',
  dachterrasse: 'Dachterrasse',
}

/** Neutral drawing geometry when a value is unknown (labels stay "missing"). */
const FALLBACK_RAIL_CM = 100
const FALLBACK_OPENING_CM = 10
const FALLBACK_GAP_CM = 4

export const GuardrailCheckCard: FC<GuardrailCheckCardProps> = ({
  title,
  context,
  fall_height,
  rail_height,
  max_opening,
  bottom_gap,
  has_horizontal_elements_in_climb_zone: climbables,
  reference,
  note,
}) => {
  const railH = rail_height.value ?? FALLBACK_RAIL_CM
  const opening = Math.max(max_opening.value ?? FALLBACK_OPENING_CM, 2)
  const gap = bottom_gap ? (bottom_gap.value ?? FALLBACK_GAP_CM) : 0

  const runW = 190 // cm of railing run drawn
  const dropCm = Math.max(railH * 0.42, 36) // symbolic drop below the deck
  const deckT = 9 // deck slab thickness, cm

  const k = fitScale(runW, railH + deckT + dropCm, 320, 214)
  const padL = 96
  const padTop = 20
  const x0 = padL
  const deckY = padTop + railH * k // deck top = railing base
  const X = (cm: number): number => x0 + cm * k
  const Y = (cm: number): number => deckY - cm * k // cm above the deck

  const railTopY = Y(railH)
  const postW = 3.2 * k
  const railT = 3 * k

  // No-climb band 15–60 cm, clipped to the railing height.
  const bandLo = Math.min(15, railH)
  const bandHi = Math.min(60, railH)
  const bandColor = climbables
    ? 'var(--text-color-feedback-danger)'
    : 'var(--text-color-feedback-warning)'

  // Explicit balusters: bars spaced so each clear gap IS the max opening.
  const infillX0 = x0 + postW
  const infillW = runW * k - 2 * postW
  const barW = 1.8 * k
  const openPx = opening * k
  const barCount = Math.max(Math.floor((infillW - openPx) / (openPx + barW)), 0)
  const barXs = Array.from({ length: barCount }, (_, i) => infillX0 + (i + 1) * openPx + i * barW)
  // Opening arrow between two adjacent bars near the middle of the run.
  const openIdx = Math.max(Math.floor(barCount / 2) - 1, 0)
  const openX1 = barCount > 1 ? barXs[openIdx] + barW : infillX0
  const openX2 = barCount > 1 ? barXs[openIdx + 1] : infillX0 + openPx
  const openY = Y(railH * 0.68)

  const checks: DimensionCheckData[] = [
    { ...fall_height, label: fall_height.label || 'Absturzhöhe', unit: fall_height.unit ?? 'm' },
    { ...rail_height, label: rail_height.label || 'Geländerhöhe', unit: rail_height.unit ?? 'cm' },
    { ...max_opening, label: max_opening.label || 'max. Öffnungsweite', unit: max_opening.unit ?? 'cm' },
    ...(bottom_gap
      ? [{ ...bottom_gap, label: bottom_gap.label || 'Bodenspalt', unit: bottom_gap.unit ?? 'cm' }]
      : []),
  ]

  const dropBottomY = deckY + deckT * k + dropCm * k
  const viewW = padL + runW * k + 64
  const viewH = dropBottomY + 26

  return (
    <SchematicCard
      icon={Fence}
      eyebrow="Skizze"
      title={title}
      verdict={worstStatus(checks.map((c) => c.status))}
      note={note}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} minWidth={420} label={title}>
        <SvgLabel x={x0} y={padTop - 8} size={8} weight={600}>
          ANSICHT · {CONTEXT_LABEL[context].toUpperCase()}
        </SvgLabel>

        {/* no-climb band behind the infill */}
        <rect
          x={x0 - 6}
          y={Y(bandHi)}
          width={runW * k + 12}
          height={(bandHi - bandLo) * k}
          fill={`color-mix(in oklch, ${bandColor} 12%, transparent)`}
        />
        <SvgLabel
          x={x0 + runW * k * 0.5}
          y={Y((bandLo + bandHi) / 2)}
          anchor="middle"
          size={8}
          fill={bandColor}
          italic
        >
          Kletterschutz 15–60 cm
        </SvgLabel>

        {/* deck slab the railing stands on */}
        {sketchRect(x0 - 22, deckY, runW * k + 30, deckT * k, 'guardrail-deck', {
          strokeWidth: 1.5,
          fill: 'color-mix(in oklch, var(--muted-foreground) 50%, transparent)',
          fillStyle: 'hachure',
          fillWeight: 0.5,
          hachureGap: 7,
        })}

        {/* posts + top rail */}
        {sketchRect(x0, Y(railH), postW, railH * k, 'guardrail-post-left', { strokeWidth: 1.3 })}
        {sketchRect(X(runW) - postW, Y(railH), postW, railH * k, 'guardrail-post-right', {
          strokeWidth: 1.3,
        })}
        {sketchRect(x0 - 4, railTopY, runW * k + 8, railT, 'guardrail-toprail', {
          strokeWidth: 1.4,
          fill: 'color-mix(in oklch, var(--foreground) 35%, transparent)',
          fillStyle: 'solid',
        })}

        {/* baluster infill: explicit vertical bars, gap = max opening to scale */}
        {barXs.map((barX, i) => (
          <line
            key={`bal-${i}`}
            x1={barX + barW / 2}
            y1={Y(railH) + railT}
            x2={barX + barW / 2}
            y2={Y(gap)}
            stroke="var(--foreground)"
            strokeWidth={Math.max(barW, 1.6)}
            opacity={0.75}
          />
        ))}

        {/* rail height, measured on the left */}
        <ExtensionLine x1={x0} y1={railTopY} x2={x0 - 32} y2={railTopY} />
        <ExtensionLine x1={x0 - 22} y1={deckY} x2={x0 - 32} y2={deckY} />
        <DimensionArrow
          x1={x0 - 28}
          y1={deckY}
          x2={x0 - 28}
          y2={railTopY}
          label={fmtDim(rail_height.value, rail_height.unit ?? 'cm')}
          status={rail_height.status}
          labelOffset={-13}
          fontSize={9.5}
        />

        {/* max opening, measured between two adjacent balusters */}
        <DimensionArrow
          x1={openX1}
          y1={openY}
          x2={openX2}
          y2={openY}
          label={fmtDim(max_opening.value, max_opening.unit ?? 'cm')}
          status={max_opening.status}
          labelOffset={-10}
          fontSize={9}
        />

        {/* bottom gap, measured at the base on the right */}
        {bottom_gap && (
          <g>
            <ExtensionLine x1={X(runW) - postW} y1={Y(gap)} x2={X(runW) + 26} y2={Y(gap)} />
            <DimensionArrow
              x1={X(runW) + 20}
              y1={deckY}
              x2={X(runW) + 20}
              y2={Y(gap)}
              label={fmtDim(bottom_gap.value, bottom_gap.unit ?? 'cm')}
              status={bottom_gap.status}
              labelOffset={11}
              fontSize={9}
            />
          </g>
        )}

        {/* Absturzhöhe below the deck: dashed arrow to a break symbol */}
        <DimensionArrow
          x1={x0 + runW * k * 0.5}
          y1={deckY + deckT * k}
          x2={x0 + runW * k * 0.5}
          y2={dropBottomY - 8}
          label={fmtDim(fall_height.value, fall_height.unit ?? 'm')}
          status={fall_height.status}
          dashed
          labelOffset={-14}
          fontSize={9.5}
        />
        {sketchLine(
          x0 + runW * k * 0.5 - 16,
          dropBottomY - 4,
          x0 + runW * k * 0.5 + 16,
          dropBottomY - 10,
          'guardrail-break',
          { strokeWidth: 1.1, stroke: 'var(--muted-foreground)', roughness: 2.2 }
        )}
        <SvgLabel x={x0 + runW * k * 0.5 + 24} y={dropBottomY - 7} size={8} italic>
          Absturzhöhe
          {rail_height.required != null
            ? ` → mind. ${fmtDim(rail_height.required, rail_height.unit ?? 'cm')}`
            : ''}
        </SvgLabel>
      </SchematicCanvas>

      <DimChecksList checks={checks} />

      {climbables === true && (
        <p className="text-xs font-medium" style={{ color: statusColor('fail') }}>
          Horizontale, zum Aufklettern geeignete Elemente im Kletterschutzbereich (15–60 cm).
        </p>
      )}
    </SchematicCard>
  )
}
