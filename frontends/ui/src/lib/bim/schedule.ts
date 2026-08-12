/**
 * Raumbuch and Massenermittlung — the two tables an architect already keeps by
 * hand, computed from the model instead.
 *
 * These are not analytics. A Flächenaufstellung goes into a Einreichung and a
 * Massenermittlung into a Kostenschätzung, so the numbers have to be the
 * model's own published quantities, not something derived from geometry we
 * re-measured. Where a room publishes no area the row says so rather than
 * showing a zero, and the storey total states how many rooms it is missing —
 * a total that quietly excludes four rooms is the failure mode this whole
 * subsystem exists to avoid.
 *
 * Pure: a function of element records.
 */

import type { BimElement, BimModelSummary } from './types'

export interface BimRoomRow {
  globalId: string
  name: string
  storeyName: string
  /** `INTERNAL` / `EXTERNAL` as authored, when the model says. */
  category: string | null
  netFloorArea: number | null
  grossFloorArea: number | null
  netVolume: number | null
  /** Clear height, when the model publishes one. */
  height: number | null
}

export interface BimStoreySchedule {
  storeyName: string
  elevation: number | null
  rooms: BimRoomRow[]
  netFloorArea: number | null
  grossFloorArea: number | null
  netVolume: number | null
  /** Rooms on this storey with no published area — the total's blind spot. */
  roomsWithoutArea: number
}

export interface BimRoomSchedule {
  storeys: BimStoreySchedule[]
  totals: {
    rooms: number
    roomsWithoutArea: number
    netFloorArea: number | null
    grossFloorArea: number | null
    netVolume: number | null
  }
  units: { area: string; volume: string; length: string }
}

const NET_AREA_KEYS = ['NetFloorArea', 'NetArea']
const GROSS_AREA_KEYS = ['GrossFloorArea', 'GrossArea']
const VOLUME_KEYS = ['NetVolume', 'GrossVolume']
const HEIGHT_KEYS = ['Height', 'FinishCeilingHeight', 'ClearHeight']

function quantity(element: BimElement, keys: readonly string[]): number | null {
  for (const set of Object.values(element.quantities)) {
    for (const key of keys) {
      const value = set[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  }
  return null
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100
}

/** Add, keeping `null` distinct from `0` — an absent area is not a zero one. */
function add(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value
}

/**
 * Build the Raumbuch: rooms grouped by storey, in storey order, with the
 * per-storey and building totals.
 */
export function buildRoomSchedule(
  summary: BimModelSummary,
  elements: readonly BimElement[]
): BimRoomSchedule {
  const spaces = elements.filter((element) => element.ifcType === 'IfcSpace')
  const byStorey = new Map<string, BimRoomRow[]>()

  for (const space of spaces) {
    const storeyName = space.storeyName ?? '(ohne Geschoß)'
    const row: BimRoomRow = {
      globalId: space.globalId,
      name: space.name ?? '(ohne Namen)',
      storeyName,
      category: space.predefinedType,
      netFloorArea: round(quantity(space, NET_AREA_KEYS)),
      grossFloorArea: round(quantity(space, GROSS_AREA_KEYS)),
      netVolume: round(quantity(space, VOLUME_KEYS)),
      height: round(quantity(space, HEIGHT_KEYS)),
    }
    const bucket = byStorey.get(storeyName)
    if (bucket) bucket.push(row)
    else byStorey.set(storeyName, [row])
  }

  // Storey order comes from the summary (sorted by elevation); rooms whose
  // storey the model never named go last under their own heading rather than
  // being dropped, because they still count toward the building total.
  const ordered: BimStoreySchedule[] = []
  const seen = new Set<string>()
  for (const storey of summary.storeys) {
    const name = storey.name ?? '(ohne Namen)'
    const rooms = byStorey.get(name)
    if (!rooms) continue
    seen.add(name)
    ordered.push(summarizeStorey(name, storey.elevation, rooms))
  }
  for (const [name, rooms] of byStorey) {
    if (seen.has(name)) continue
    ordered.push(summarizeStorey(name, null, rooms))
  }

  const totals = ordered.reduce(
    (acc, storey) => ({
      rooms: acc.rooms + storey.rooms.length,
      roomsWithoutArea: acc.roomsWithoutArea + storey.roomsWithoutArea,
      netFloorArea: add(acc.netFloorArea, storey.netFloorArea),
      grossFloorArea: add(acc.grossFloorArea, storey.grossFloorArea),
      netVolume: add(acc.netVolume, storey.netVolume),
    }),
    {
      rooms: 0,
      roomsWithoutArea: 0,
      netFloorArea: null as number | null,
      grossFloorArea: null as number | null,
      netVolume: null as number | null,
    }
  )

  return {
    storeys: ordered,
    totals: {
      ...totals,
      netFloorArea: round(totals.netFloorArea),
      grossFloorArea: round(totals.grossFloorArea),
      netVolume: round(totals.netVolume),
    },
    units: {
      area: summary.units.area?.symbol ?? 'm²',
      volume: summary.units.volume?.symbol ?? 'm³',
      length: summary.units.length?.symbol ?? 'm',
    },
  }
}

function summarizeStorey(
  storeyName: string,
  elevation: number | null,
  rooms: BimRoomRow[]
): BimStoreySchedule {
  const sorted = [...rooms].sort((a, b) => a.name.localeCompare(b.name))
  return {
    storeyName,
    elevation,
    rooms: sorted,
    netFloorArea: round(sorted.reduce<number | null>((sum, room) => add(sum, room.netFloorArea), null)),
    grossFloorArea: round(
      sorted.reduce<number | null>((sum, room) => add(sum, room.grossFloorArea), null)
    ),
    netVolume: round(sorted.reduce<number | null>((sum, room) => add(sum, room.netVolume), null)),
    roomsWithoutArea: sorted.filter((room) => room.netFloorArea === null).length,
  }
}

export interface BimQuantityRow {
  /** `IfcWall`, or `IfcWall · Stahlbeton` when grouped by material too. */
  group: string
  elements: number
  /** Sum of the named quantity across the group; `null` when none publishes it. */
  value: number | null
  /** Elements in the group that publish nothing for this quantity. */
  missing: number
}

export const BIM_TAKEOFF_QUANTITIES = [
  'NetSideArea',
  'GrossSideArea',
  'NetVolume',
  'GrossVolume',
  'NetFloorArea',
  'GrossFloorArea',
  'Length',
  'Width',
  'Height',
] as const

/**
 * Massenermittlung: one quantity, summed per type — optionally split by the
 * element's primary material, which is how a Kostenschätzung wants it.
 *
 * `missing` is part of the row, not a footnote. "412 m² of concrete wall" over
 * a set where 30 walls publish no area is a different number from the same
 * figure over a complete one, and only one of them can go in a submission.
 */
export function buildQuantityTakeoff(
  elements: readonly BimElement[],
  options: { quantity: string; byMaterial?: boolean }
): BimQuantityRow[] {
  const groups = new Map<string, { elements: number; value: number | null; missing: number }>()

  for (const element of elements) {
    const material = options.byMaterial ? (element.materials[0] ?? '(ohne Material)') : null
    const key = material ? `${element.ifcType} · ${material}` : element.ifcType
    const entry = groups.get(key) ?? { elements: 0, value: null, missing: 0 }
    entry.elements += 1
    const value = quantity(element, [options.quantity])
    if (value === null) entry.missing += 1
    else entry.value = (entry.value ?? 0) + value
    groups.set(key, entry)
  }

  return [...groups.entries()]
    .map(([group, entry]) => ({ group, ...entry, value: round(entry.value) }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.group.localeCompare(b.group))
}

/** CSV for the Raumbuch — the export an architect pastes into their own sheet. */
export function roomScheduleToCsv(schedule: BimRoomSchedule): string {
  const header = [
    'Geschoß',
    'Raum',
    'Kategorie',
    `Netto-Grundfläche (${schedule.units.area})`,
    `Brutto-Grundfläche (${schedule.units.area})`,
    `Rauminhalt (${schedule.units.volume})`,
    `Höhe (${schedule.units.length})`,
    'GlobalId',
  ]
  /**
   * A semicolon file for German-locale Excel, with German decimals.
   *
   * The separator was already chosen for that audience — and every number went
   * in as `String(24.5)`, which German Excel reads as TEXT. The downloaded
   * Raumbuch would not sum, which is the one thing anyone downloads a Raumbuch
   * to do. A comma decimal is what the same spreadsheet expects, and it is
   * safe precisely because the separator is a semicolon.
   */
  const escape = (value: string | number | null): string => {
    if (value === null) return ''
    const raw = typeof value === 'number' ? String(value).replace('.', ',') : String(value)
    // A leading `=`, `+`, `-` or `@` makes Excel read the cell as a FORMULA.
    // Room and component names come out of an uploaded IFC, so a room called
    // `=HYPERLINK(...)` is a live formula in the German-locale spreadsheet
    // this export exists for — pasted there by whoever produced the file, and
    // opened by whoever the Raumbuch was sent to. A leading apostrophe is
    // Excel's own "this is text" marker and does not show in the cell.
    const text = typeof value === 'string' && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [header.join(';')]
  for (const storey of schedule.storeys) {
    for (const room of storey.rooms) {
      lines.push(
        [
          storey.storeyName,
          room.name,
          room.category,
          room.netFloorArea,
          room.grossFloorArea,
          room.netVolume,
          room.height,
          room.globalId,
        ]
          .map(escape)
          .join(';')
      )
    }
    lines.push(
      [
        `${storey.storeyName} — Summe`,
        '',
        '',
        storey.netFloorArea,
        storey.grossFloorArea,
        storey.netVolume,
        '',
        '',
      ]
        .map(escape)
        .join(';')
    )
  }
  lines.push(
    ['Gesamt', '', '', schedule.totals.netFloorArea, schedule.totals.grossFloorArea, schedule.totals.netVolume, '', '']
      .map(escape)
      .join(';')
  )
  // Semicolon-separated: the German/Austrian Excel default, where a
  // comma-separated file with decimal commas lands in one column.
  return lines.join('\n')
}
