/**
 * ThermalEnvelopeCard — Wärmeschutz: a building-envelope cross-section with a
 * U-value limit bar per component (OIB 6).
 *
 * A simple house section (floor, two walls, pitched roof, a window and a door)
 * is drawn once; every envelope component the model supplies tints its matching
 * element by check status, so a failing Außenwand reads red on the wall itself.
 * Below the section, one LimitBar per component reads its U-value against the
 * maximum permitted — lower is better, so the bar fills toward the limit tick.
 */

import { type FC } from 'react'
import { Thermometer } from 'lucide-react'
import {
  LimitBar,
  SchematicCanvas,
  SchematicCard,
  statusColor,
  SvgLabel,
  worstStatus,
} from './kit'
import { sketchLine, sketchPath, sketchRect } from './rough'
import type { DimStatus, EnvelopeComponentData, NormReferenceData } from './types'

interface ThermalEnvelopeCardProps {
  title: string
  components: EnvelopeComponentData[]
  reference?: NormReferenceData | null
  note?: string | null
}

const NEUTRAL = 'var(--foreground)'

export const ThermalEnvelopeCard: FC<ThermalEnvelopeCardProps> = ({
  title,
  components,
  reference,
  note,
}) => {
  // Status per envelope kind, so each drawn element can pick up its verdict.
  const statusByKind = new Map<EnvelopeComponentData['kind'], DimStatus>()
  for (const c of components) statusByKind.set(c.kind, c.u_value.status)
  const colorFor = (kind: EnvelopeComponentData['kind']): string => {
    const s = statusByKind.get(kind)
    return s ? statusColor(s) : NEUTRAL
  }
  const strokeFor = (kind: EnvelopeComponentData['kind']): number => (statusByKind.has(kind) ? 2.4 : 1.4)

  // House geometry.
  const x0 = 60
  const x1 = 220
  const wallTop = 66
  const wallBottom = 150
  const ridgeX = (x0 + x1) / 2
  const ridgeY = 30

  const viewW = 300
  const viewH = 176

  return (
    <SchematicCard
      icon={Thermometer}
      eyebrow="Schematic"
      title={title}
      verdict={worstStatus(components.map((c) => c.u_value.status))}
      note={note}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} minWidth={300} label={title}>
        {/* roof */}
        {sketchPath(
          [
            [x0 - 10, wallTop],
            [ridgeX, ridgeY],
            [x1 + 10, wallTop],
          ],
          'env-roof',
          { strokeWidth: strokeFor('roof'), stroke: colorFor('roof') }
        )}
        {/* left + right walls */}
        {sketchLine(x0, wallTop, x0, wallBottom, 'env-wall-l', {
          strokeWidth: strokeFor('wall'),
          stroke: colorFor('wall'),
        })}
        {sketchLine(x1, wallTop, x1, wallBottom, 'env-wall-r', {
          strokeWidth: strokeFor('wall'),
          stroke: colorFor('wall'),
        })}
        {/* floor slab */}
        {sketchLine(x0 - 8, wallBottom, x1 + 8, wallBottom, 'env-floor', {
          strokeWidth: strokeFor('floor'),
          stroke: colorFor('floor'),
        })}
        {/* window on the left field */}
        {sketchRect(x0 + 22, 92, 34, 30, 'env-window', {
          strokeWidth: strokeFor('window'),
          stroke: colorFor('window'),
        })}
        {/* door on the right field */}
        {sketchRect(x1 - 52, 108, 26, 42, 'env-door', {
          strokeWidth: strokeFor('door'),
          stroke: colorFor('door'),
        })}
        {/* ground hatch */}
        {[...Array(9)].map((_, i) => (
          <line
            key={`g-${i}`}
            x1={x0 - 8 + i * 24}
            y1={wallBottom}
            x2={x0 - 16 + i * 24}
            y2={wallBottom + 8}
            stroke="var(--muted-foreground)"
            strokeWidth={0.8}
            opacity={0.5}
          />
        ))}
        <SvgLabel x={ridgeX} y={ridgeY - 6} anchor="middle" size={9}>
          Gebäudehülle
        </SvgLabel>
      </SchematicCanvas>

      <div className="flex flex-col gap-2.5">
        {components.map((component, i) => (
          <LimitBar
            key={`u-${i}`}
            check={{
              ...component.u_value,
              label: component.u_value.label || component.label,
              unit: component.u_value.unit ?? 'W/(m²K)',
              comparator: component.u_value.comparator ?? '<=',
            }}
          />
        ))}
      </div>
    </SchematicCard>
  )
}
