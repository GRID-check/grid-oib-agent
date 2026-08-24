/**
 * FireCompartmentCard — Brandabschnitte: a storey plan split into fire
 * compartments, each area-checked against the maximum Brandabschnittsfläche.
 *
 * The storey outline is a single wide rectangle; compartments are drawn as
 * side-by-side bands whose WIDTH is proportional to their floor area, separated
 * by a bold Brandwand line. Each band is tinted by its check status and labelled
 * with its name, use, and area; unknown areas render an even share with a
 * dashed outline and "fehlende Angabe" — never a guessed size. A checks legend
 * lists every compartment's area vs its limit below the drawing.
 */

import { type FC } from 'react'
import { Flame } from 'lucide-react'
import {
  DimChecksList,
  fmtDim,
  missingLabel,
  SchematicCanvas,
  SchematicCard,
  statusColor,
  SvgLabel,
  worstStatus,
} from './kit'
import { sketchRect } from './rough'
import { useTranslations } from '@/i18n'
import type { FireCompartmentData, NormReferenceData } from './types'

interface FireCompartmentCardProps {
  title: string
  storey_label?: string | null
  compartments: FireCompartmentData[]
  gebaeudeklasse?: string | null
  reference?: NormReferenceData | null
  note?: string | null
}

export const FireCompartmentCard: FC<FireCompartmentCardProps> = ({
  title,
  storey_label: storeyLabel,
  compartments,
  gebaeudeklasse,
  reference,
  note,
}) => {
  const t = useTranslations('chat')
  const px = 20
  const py = 30
  const PW = 300
  const PD = 132

  // Band widths track floor area; unknown areas fall back to an equal share so
  // the plan still reads, but stay visually flagged (dashed) in the drawing.
  const areas = compartments.map((c) => c.area.value ?? null)
  const known = areas.filter((a): a is number => a != null)
  const fallback = known.length ? known.reduce((s, a) => s + a, 0) / known.length : 1
  const weights = areas.map((a) => (a != null ? a : fallback))
  const totalWeight = weights.reduce((s, w) => s + w, 0) || 1

  const viewW = px + PW + 20
  const viewH = py + PD + 24

  let cursor = px
  const bands = compartments.map((compartment, i) => {
    const w = (weights[i] / totalWeight) * PW
    const x = cursor
    cursor += w
    const midX = x + w / 2
    const known = compartment.area.value != null
    const color = statusColor(compartment.area.status)
    return (
      <g key={`ba-${i}`}>
        {known ? (
          sketchRect(x, py, w, PD, `ba-fill-${i}`, {
            strokeWidth: 1.3,
            stroke: `color-mix(in oklch, ${color} 75%, transparent)`,
            fill: `color-mix(in oklch, ${color} 45%, transparent)`,
            fillStyle: 'hachure',
            fillWeight: 0.45,
            hachureGap: 11,
          })
        ) : (
          <rect
            x={x}
            y={py}
            width={w}
            height={PD}
            fill="none"
            stroke="var(--muted-foreground)"
            strokeWidth={1}
            strokeDasharray="5 4"
          />
        )}
        {/* Brandwand between compartments — bold separator line. */}
        {i > 0 && (
          <line
            x1={x}
            y1={py - 6}
            x2={x}
            y2={py + PD + 6}
            stroke="var(--text-color-feedback-danger)"
            strokeWidth={2.4}
          />
        )}
        <SvgLabel x={midX} y={py + PD / 2 - 12} anchor="middle" weight={600} fill="var(--foreground)" size={9.5}>
          {compartment.label}
        </SvgLabel>
        {compartment.use && (
          <SvgLabel x={midX} y={py + PD / 2 + 1} anchor="middle" size={8.5}>
            {compartment.use}
          </SvgLabel>
        )}
        <SvgLabel
          x={midX}
          y={py + PD / 2 + 14}
          anchor="middle"
          mono={known}
          italic={!known}
          size={8.5}
          fill={known ? color : 'var(--muted-foreground)'}
        >
          {known
            ? fmtDim(compartment.area.value, compartment.area.unit ?? 'm²', t)
            : missingLabel(t)}
        </SvgLabel>
      </g>
    )
  })

  const areaChecks = compartments.map((c) => ({
    ...c.area,
    label: c.area.label || c.label,
    unit: c.area.unit ?? 'm²',
    comparator: c.area.comparator ?? '<=',
  }))

  return (
    <SchematicCard
      icon={Flame}
      title={title}
      verdict={worstStatus(compartments.map((c) => c.area.status))}
      note={note}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
        <SvgLabel x={px} y={py - 12} size={9}>
          {storeyLabel
            ? t('cards.schematics.fireCompartment.storey', { label: storeyLabel })
            : t('cards.schematics.fireCompartment.plan')}
          {gebaeudeklasse ? ` · ${gebaeudeklasse}` : ''}
        </SvgLabel>
        {/* outer storey outline */}
        {sketchRect(px, py, PW, PD, 'ba-outline', { strokeWidth: 1.6 })}
        {bands}
      </SchematicCanvas>

      <DimChecksList checks={areaChecks} />
    </SchematicCard>
  )
}
