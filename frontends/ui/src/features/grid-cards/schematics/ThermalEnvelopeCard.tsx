/**
 * ThermalEnvelopeCard — Wärmeschutz: a building-envelope cross-section with a
 * U-value limit bar per component (OIB 6).
 *
 * A proper section, not a pictogram: floor slab and walls drawn with real
 * thickness, a pitched roof band, a glazed window opening in the left wall and
 * a door opening in the right one. Each checked component is tinted subtly by
 * its status and labelled with a status-coloured dot + leader outside the
 * section, so a failing Dach reads at a glance without the drawing turning
 * into crayon. Below the section, one LimitBar per component reads its U-value
 * against the maximum permitted (lower is better).
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

type Kind = EnvelopeComponentData['kind']

export const ThermalEnvelopeCard: FC<ThermalEnvelopeCardProps> = ({
  title,
  components,
  reference,
  note,
}) => {
  // Status per envelope kind, so each drawn element can pick up its verdict.
  const statusByKind = new Map<Kind, DimStatus>()
  const labelByKind = new Map<Kind, string>()
  for (const c of components) {
    statusByKind.set(c.kind, c.u_value.status)
    labelByKind.set(c.kind, c.label)
  }
  const tintFor = (kind: Kind): string | undefined => {
    const s = statusByKind.get(kind)
    return s ? `color-mix(in oklch, ${statusColor(s)} 16%, transparent)` : undefined
  }

  // Section geometry: walls/floor with real thickness, pitched roof band.
  const xL = 84 // outer face, left wall
  const xR = 252 // outer face, right wall
  const wallT = 9
  const eaveY = 74
  const floorTopY = 158
  const floorT = 10
  const ridgeX = (xL + xR) / 2
  const ridgeY = 26
  const groundY = floorTopY + floorT

  // Window opening in the left wall, door opening in the right wall.
  const winTop = 98
  const winBottom = 128
  const doorTop = 116

  const viewW = 356
  const viewH = groundY + 24

  /** Status dot + label + thin leader line to the element it annotates. */
  const callout = (
    kind: Kind,
    fallback: string,
    textX: number,
    textY: number,
    anchor: 'start' | 'end',
    leadX: number,
    leadY: number
  ) => {
    const status = statusByKind.get(kind)
    if (!status) return null
    const color = statusColor(status)
    const dotX = anchor === 'end' ? textX + 6 : textX - 6
    return (
      <g key={`co-${kind}`}>
        <line
          x1={dotX}
          y1={textY}
          x2={leadX}
          y2={leadY}
          stroke={color}
          strokeWidth={0.8}
          opacity={0.6}
        />
        <circle cx={dotX} cy={textY} r={2.6} fill={color} />
        <SvgLabel
          x={anchor === 'end' ? textX : textX + 5}
          y={textY}
          anchor={anchor}
          size={9}
          weight={600}
          fill={color}
        >
          {labelByKind.get(kind) || fallback}
        </SvgLabel>
      </g>
    )
  }

  return (
    <SchematicCard
      icon={Thermometer}
      eyebrow="Skizze"
      title={title}
      verdict={worstStatus(components.map((c) => c.u_value.status))}
      note={note}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
        {/* ground line + hatch ticks */}
        <line
          x1={xL - 34}
          y1={groundY}
          x2={xR + 34}
          y2={groundY}
          stroke="var(--foreground)"
          strokeWidth={1.4}
        />
        {Array.from({ length: 10 }, (_, i) => {
          const gx = xL - 28 + i * ((xR + 34 - (xL - 28)) / 9)
          return (
            <line
              key={`gh-${i}`}
              x1={gx}
              y1={groundY}
              x2={gx - 6}
              y2={groundY + 6}
              stroke="var(--muted-foreground)"
              strokeWidth={0.8}
              opacity={0.5}
            />
          )
        })}

        {/* floor slab (bodennahe Decke) with thickness */}
        {sketchRect(xL - 6, floorTopY, xR - xL + 12, floorT, 'env-floor', {
          strokeWidth: 1.3,
          fill:
            tintFor('floor') ?? 'color-mix(in oklch, var(--muted-foreground) 30%, transparent)',
          fillStyle: tintFor('floor') ? 'solid' : 'hachure',
          fillWeight: 0.5,
          hachureGap: 6,
        })}

        {/* left wall in two segments around the window opening */}
        {sketchRect(xL, eaveY, wallT, winTop - eaveY, 'env-wall-l1', {
          strokeWidth: 1.3,
          fill: tintFor('wall'),
          fillStyle: 'solid',
        })}
        {sketchRect(xL, winBottom, wallT, floorTopY - winBottom, 'env-wall-l2', {
          strokeWidth: 1.3,
          fill: tintFor('wall'),
          fillStyle: 'solid',
        })}
        {/* right wall in two segments around the door opening */}
        {sketchRect(xR - wallT, eaveY, wallT, doorTop - eaveY, 'env-wall-r1', {
          strokeWidth: 1.3,
          fill: tintFor('wall'),
          fillStyle: 'solid',
        })}

        {/* window glazing in the opening: double line + sill ticks */}
        <line
          x1={xL + wallT / 2 - 1.2}
          y1={winTop + 1}
          x2={xL + wallT / 2 - 1.2}
          y2={winBottom - 1}
          stroke={statusByKind.has('window') ? statusColor(statusByKind.get('window')!) : 'var(--foreground)'}
          strokeWidth={1.4}
        />
        <line
          x1={xL + wallT / 2 + 1.8}
          y1={winTop + 1}
          x2={xL + wallT / 2 + 1.8}
          y2={winBottom - 1}
          stroke={statusByKind.has('window') ? statusColor(statusByKind.get('window')!) : 'var(--foreground)'}
          strokeWidth={0.8}
          opacity={0.6}
        />
        {[winTop, winBottom].map((y) => (
          <line
            key={`sill-${y}`}
            x1={xL - 3}
            y1={y}
            x2={xL + wallT + 3}
            y2={y}
            stroke="var(--foreground)"
            strokeWidth={1}
          />
        ))}

        {/* door leaf in the right opening */}
        <line
          x1={xR - wallT / 2}
          y1={doorTop + 1}
          x2={xR - wallT / 2}
          y2={floorTopY - 1}
          stroke={statusByKind.has('door') ? statusColor(statusByKind.get('door')!) : 'var(--foreground)'}
          strokeWidth={1.6}
        />
        <line
          x1={xR - wallT - 3}
          y1={doorTop}
          x2={xR + 3}
          y2={doorTop}
          stroke="var(--foreground)"
          strokeWidth={1}
        />

        {/* pitched roof band with thickness */}
        {sketchPath(
          [
            [xL - 14, eaveY + 4],
            [ridgeX, ridgeY],
            [xR + 14, eaveY + 4],
          ],
          'env-roof-outer',
          { strokeWidth: 1.4 }
        )}
        {sketchPath(
          [
            [xL + 2, eaveY + 4],
            [ridgeX, ridgeY + 12],
            [xR - 2, eaveY + 4],
          ],
          'env-roof-inner',
          {
            strokeWidth: 1.1,
            stroke: 'var(--muted-foreground)',
          }
        )}
        {/* subtle roof tint between the two slopes */}
        {statusByKind.has('roof') && (
          <path
            d={`M ${xL - 14} ${eaveY + 4} L ${ridgeX} ${ridgeY} L ${xR + 14} ${eaveY + 4} L ${xR - 2} ${eaveY + 4} L ${ridgeX} ${ridgeY + 12} L ${xL + 2} ${eaveY + 4} Z`}
            fill={tintFor('roof')}
            stroke="none"
          />
        )}
        {/* eaves line closing the section */}
        {sketchLine(xL, eaveY, xR, eaveY, 'env-eaves', {
          strokeWidth: 0.9,
          stroke: 'var(--muted-foreground)',
        })}

        {/* status callouts with leader lines */}
        {callout('roof', 'Dach', ridgeX + 46, ridgeY + 6, 'start', ridgeX + 18, ridgeY + 11)}
        {callout('wall', 'Außenwand', xL - 20, eaveY + 14, 'end', xL, eaveY + 16)}
        {callout(
          'window',
          'Fenster',
          xL - 20,
          (winTop + winBottom) / 2,
          'end',
          xL - 3,
          (winTop + winBottom) / 2
        )}
        {callout('door', 'Tür', xR + 20, doorTop + 20, 'start', xR + 1, doorTop + 22)}
        {callout('floor', 'Boden', xR + 20, floorTopY + floorT / 2, 'start', xR + 7, floorTopY + floorT / 2)}
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
