/**
 * FireAccessPlanCard — OIB 2 / TRVB Feuerwehrzufahrt: a top-down site plan.
 *
 * Same drawing language as SetbackPlanCard: parcel to scale, hachured
 * building footprint, street band anchoring the front. Added fire layer: the
 * access-route strip runs from the street to the Aufstellfläche at its real
 * clear width (edges + width arrow coloured by the route check), the
 * Aufstellfläche sits beside the front facade at its real width × length with
 * its clearance to the facade dimensioned, and a reach arrow measures the
 * walk distance to the farthest necessary entrance, coloured by its status.
 * Durchfahrt height (not drawable in plan) and Gebäudeklasse surface in the
 * legend. Unknown values read "fehlende Angabe", never a guessed number.
 */

import { type FC } from 'react'
import { Flame } from 'lucide-react'
import {
  DimChecksList,
  DimensionArrow,
  ExtensionLine,
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
import type { AufstellflaechePlanData, DimensionCheckData, NormReferenceData } from './types'

interface FireAccessPlanCardProps {
  title: string
  parcel_width_m: number
  parcel_depth_m: number
  building_width_m: number
  building_depth_m: number
  route_width: DimensionCheckData
  gate_clearance_height?: DimensionCheckData | null
  aufstellflaeche: AufstellflaechePlanData
  walk_distance_to_entrance: DimensionCheckData
  gebaeudeklasse?: string | null
  reference?: NormReferenceData | null
  note?: string | null
}

/** Neutral drawing geometry when a value is unknown (labels stay "missing"). */
const FALLBACK_ROUTE_W_M = 3
const FALLBACK_AUFSTELL_W_M = 5
const FALLBACK_AUFSTELL_L_M = 10
const FALLBACK_FACADE_DIST_M = 1

export const FireAccessPlanCard: FC<FireAccessPlanCardProps> = ({
  title,
  parcel_width_m: parcelW,
  parcel_depth_m: parcelD,
  building_width_m: buildingW,
  building_depth_m: buildingD,
  route_width,
  gate_clearance_height,
  aufstellflaeche,
  walk_distance_to_entrance,
  gebaeudeklasse,
  reference,
  note,
}) => {
  const k = fitScale(parcelW, parcelD, 304, 236)
  const px = 60
  const py = 26
  const PW = parcelW * k
  const PD = parcelD * k

  // Building toward the back-right, leaving the front-left free for the route.
  const bxM = Math.max((parcelW - buildingW) * 0.62, 0)
  const byM = Math.max((parcelD - buildingD) * 0.22, 0)
  const bx = px + bxM * k
  const by = py + byM * k
  const BW = buildingW * k
  const BD = buildingD * k
  const facadeY = by + BD // front facade (street side)

  // Access route: a strip at its real clear width, street → Aufstellfläche.
  const routeWm = route_width.value ?? FALLBACK_ROUTE_W_M
  const routeXm = Math.max(Math.min(bxM * 0.3, parcelW - routeWm), 0.4)
  const rx = px + routeXm * k
  const RW = Math.min(routeWm * k, PW - (rx - px))
  const routeColor = statusColor(route_width.status)

  // Aufstellfläche beside the front facade, fed by the route.
  const aufW = aufstellflaeche.width.value ?? FALLBACK_AUFSTELL_W_M // perpendicular to facade
  const aufL = aufstellflaeche.length.value ?? FALLBACK_AUFSTELL_L_M // along the facade
  const facadeDist = aufstellflaeche.distance_to_facade?.value ?? FALLBACK_FACADE_DIST_M
  const ax = Math.max(rx + RW, bx)
  const ay = facadeY + facadeDist * k
  const AL = Math.min(aufL * k, px + PW - ax - 6)
  const AW = Math.min(aufW * k, py + PD - ay - 8)
  const aufWorst = worstStatus(
    [aufstellflaeche.width.status, aufstellflaeche.length.status].concat(
      aufstellflaeche.distance_to_facade ? [aufstellflaeche.distance_to_facade.status] : []
    )
  )
  const aufColor = aufWorst === 'fail' ? statusColor('fail') : 'var(--text-color-feedback-info)'
  const routeBottomY = py + PD
  const routeTopY = ay + AW / 2

  // Entrance on the far end of the front facade; reach measured from the
  // Aufstellfläche's near top corner.
  const doorX = bx + BW * 0.88
  const walkColor = statusColor(walk_distance_to_entrance.status)

  const streetY = py + PD + 12
  const viewW = px + PW + 72
  const viewH = streetY + 26

  const checks: DimensionCheckData[] = [
    { ...route_width, label: route_width.label || 'Zufahrt Breite', unit: route_width.unit ?? 'm' },
    ...(gate_clearance_height
      ? [
          {
            ...gate_clearance_height,
            label: gate_clearance_height.label || 'Durchfahrt lichte Höhe',
            unit: gate_clearance_height.unit ?? 'm',
          },
        ]
      : []),
    {
      ...aufstellflaeche.width,
      label: aufstellflaeche.width.label || 'Aufstellfläche Breite',
      unit: aufstellflaeche.width.unit ?? 'm',
    },
    {
      ...aufstellflaeche.length,
      label: aufstellflaeche.length.label || 'Aufstellfläche Länge',
      unit: aufstellflaeche.length.unit ?? 'm',
    },
    ...(aufstellflaeche.distance_to_facade
      ? [
          {
            ...aufstellflaeche.distance_to_facade,
            label: aufstellflaeche.distance_to_facade.label || 'Abstand zur Fassade',
            unit: aufstellflaeche.distance_to_facade.unit ?? 'm',
          },
        ]
      : []),
    {
      ...walk_distance_to_entrance,
      label: walk_distance_to_entrance.label || 'Weg zum Eingang',
      unit: walk_distance_to_entrance.unit ?? 'm',
    },
  ]

  return (
    <SchematicCard
      icon={Flame}
      eyebrow="Skizze"
      title={title}
      verdict={worstStatus(checks.map((c) => c.status))}
      note={note}
      reference={reference}
    >
      <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
        {/* parcel */}
        {sketchRect(px, py, PW, PD, 'fire-parcel', { strokeWidth: 1.5 })}
        <SvgLabel x={px} y={py - 11} size={9}>
          Grundstück {fmtNum(parcelW)} × {fmtNum(parcelD)} m
        </SvgLabel>

        {/* access route strip, street → Aufstellfläche */}
        <rect
          x={rx}
          y={routeTopY}
          width={RW}
          height={routeBottomY - routeTopY}
          fill={`color-mix(in oklch, ${routeColor} 10%, transparent)`}
        />
        <line x1={rx} y1={routeTopY} x2={rx} y2={routeBottomY} stroke={routeColor} strokeWidth={1.2} strokeDasharray="6 4" />
        <line x1={rx + RW} y1={routeTopY} x2={rx + RW} y2={routeBottomY} stroke={routeColor} strokeWidth={1.2} strokeDasharray="6 4" />
        <SvgLabel
          x={rx + RW / 2}
          y={routeTopY + (routeBottomY - routeTopY) * 0.32}
          anchor="middle"
          size={8}
          weight={600}
          fill={routeColor}
          transform={`rotate(-90 ${rx + RW / 2} ${routeTopY + (routeBottomY - routeTopY) * 0.32})`}
        >
          ZUFAHRT
        </SvgLabel>
        <DimensionArrow
          x1={rx}
          y1={routeBottomY - 12}
          x2={rx + RW}
          y2={routeBottomY - 12}
          label={fmtDim(route_width.value, route_width.unit ?? 'm')}
          status={route_width.status}
          labelOffset={-10}
          fontSize={9}
        />

        {/* building footprint */}
        {sketchRect(bx, by, BW, BD, 'fire-building', {
          strokeWidth: 1.4,
          fill: 'color-mix(in oklch, var(--foreground) 40%, transparent)',
          fillStyle: 'hachure',
          fillWeight: 0.5,
          hachureGap: 7,
        })}
        <SvgLabel x={bx + BW / 2} y={by + BD / 2 - 6} anchor="middle" weight={600} fill="var(--foreground)" size={9.5}>
          Gebäude
        </SvgLabel>
        <SvgLabel x={bx + BW / 2} y={by + BD / 2 + 7} anchor="middle" mono size={8.5}>
          {fmtNum(buildingW)} × {fmtNum(buildingD)} m
        </SvgLabel>

        {/* Aufstellfläche beside the front facade */}
        <rect
          x={ax}
          y={ay}
          width={AL}
          height={AW}
          fill={`color-mix(in oklch, ${aufColor} 10%, transparent)`}
          stroke={aufColor}
          strokeWidth={1.2}
          strokeDasharray="6 4"
        />
        <SvgLabel x={ax + AL / 2} y={ay + AW / 2} anchor="middle" size={8.5} weight={600} fill={aufColor}>
          Aufstellfläche
        </SvgLabel>
        <DimensionArrow
          x1={ax}
          y1={ay + AW + 10}
          x2={ax + AL}
          y2={ay + AW + 10}
          label={fmtDim(aufstellflaeche.length.value, aufstellflaeche.length.unit ?? 'm')}
          status={aufstellflaeche.length.status}
          labelOffset={9}
          fontSize={9}
        />
        <DimensionArrow
          x1={ax + AL + 10}
          y1={ay + AW}
          x2={ax + AL + 10}
          y2={ay}
          label={fmtDim(aufstellflaeche.width.value, aufstellflaeche.width.unit ?? 'm')}
          status={aufstellflaeche.width.status}
          labelOffset={11}
          fontSize={9}
        />
        {aufstellflaeche.distance_to_facade && (
          <g>
            <ExtensionLine x1={ax} y1={facadeY} x2={ax - 16} y2={facadeY} />
            <ExtensionLine x1={ax} y1={ay} x2={ax - 16} y2={ay} />
            <DimensionArrow
              x1={ax - 12}
              y1={facadeY}
              x2={ax - 12}
              y2={ay}
              label={fmtDim(
                aufstellflaeche.distance_to_facade.value,
                aufstellflaeche.distance_to_facade.unit ?? 'm'
              )}
              status={aufstellflaeche.distance_to_facade.status}
              labelOffset={-12}
              fontSize={8.5}
            />
          </g>
        )}

        {/* entrance door tick + reach arrow along the facade */}
        <line x1={doorX - 5} y1={facadeY} x2={doorX + 5} y2={facadeY} stroke="var(--foreground)" strokeWidth={3} strokeLinecap="round" />
        <SvgLabel x={doorX + 8} y={facadeY - 8} size={8} weight={600} fill="var(--foreground)">
          Eingang
        </SvgLabel>
        <DimensionArrow
          x1={ax + AL * 0.4}
          y1={ay - 4}
          x2={doorX}
          y2={facadeY + 3}
          label={fmtDim(walk_distance_to_entrance.value, walk_distance_to_entrance.unit ?? 'm')}
          status={walk_distance_to_entrance.status}
          dashed
          labelOffset={13}
          fontSize={9}
        />

        {/* street band anchoring the front */}
        <line x1={px - 14} y1={streetY} x2={px + PW + 14} y2={streetY} stroke="var(--muted-foreground)" strokeWidth={0.9} opacity={0.6} />
        <line x1={px - 14} y1={streetY + 10} x2={px + PW + 14} y2={streetY + 10} stroke="var(--muted-foreground)" strokeWidth={0.9} opacity={0.6} />
        <SvgLabel x={px + PW / 2} y={streetY + 5} anchor="middle" size={8} weight={600}>
          STRASSE
        </SvgLabel>

        {/* Gebäudeklasse tag */}
        {gebaeudeklasse && (
          <SvgLabel x={px + PW + 14} y={py + 8} size={9} weight={600} fill="var(--foreground)">
            {gebaeudeklasse}
          </SvgLabel>
        )}
      </SchematicCanvas>

      <DimChecksList checks={checks} />

      {gebaeudeklasse && (
        <p className="text-xs text-muted-foreground">
          Gebäudeklasse: <span className="font-medium text-foreground">{gebaeudeklasse}</span>
          {walkColor === statusColor('fail')
            ? ' — der Weg zum Eingang überschreitet das zulässige Maß.'
            : ''}
        </p>
      )}
    </SchematicCard>
  )
}
