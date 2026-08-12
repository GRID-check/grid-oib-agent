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
/**
 * Net volume only.
 *
 * `GrossVolume` used to be a fallback, so a storey's `Rauminhalt` was a
 * mixture: rooms publishing net contributed net, rooms publishing only gross
 * contributed gross, and on an ordinary Wohnbau those differ by roughly the
 * enclosing construction. A single column headed "Rauminhalt" summing two
 * different measures is worse than a column with gaps in it — the gaps are
 * visible and the mixture is not, and this product's whole stance is that an
 * absent figure stays absent rather than being approximated.
 */
const VOLUME_KEYS = ['NetVolume']
/**
 * Clear height first, which is what {@link BimRoomRow.height} promises.
 *
 * `Height` led, and `Qto_SpaceBaseQuantities.Height` is the STRUCTURAL height
 * — floor slab to floor slab. The Prüfbuch deliberately prefers
 * `FinishCeilingHeight`/`ClearHeight` for the 2,50 m rule, so the same room
 * was reported at 2,70 m in the Raumbuch and 2,52 m in the Prüfbuch, and the
 * Raumbuch column an architect eyeballs against that threshold was 15–25 cm
 * optimistic.
 */
const HEIGHT_KEYS = ['FinishCeilingHeight', 'ClearHeight', 'Height']

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
    /*
      Once per NAME, because that is what the rooms are bucketed by.

      A Wohnhausanlage exported as one IFC carries an `IfcBuildingStorey` named
      `Erdgeschoß` under each `IfcBuilding`. Both resolved to the same room
      array, so the schedule listed every ground-floor room twice, in two
      identical blocks, and the building total counted them twice: two rooms of
      40 m² and 60 m² came out as "4 Räume, 200 m²". That is the Netto-
      Grundfläche an architect copies into a Flächenaufstellung.

      `seen` was already being written here — it just was not being read until
      the loop below.
    */
    if (seen.has(name)) continue
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
    /*
      The unit the MODEL declares, or none.

      Defaulting to `m²` labelled raw model values with a unit nobody had
      verified: a millimetre-unit file that declares no AREAUNIT publishes a
      40 m² room as `40000000`, and the Raumbuch rendered "40000000 m²". A bare
      number is wrong-looking and therefore safe; a wrong unit reads as a fact.
      `query.ts` already takes this line.
    */
    units: {
      area: summary.units.area?.symbol ?? '',
      volume: summary.units.volume?.symbol ?? '',
      length: summary.units.length?.symbol ?? '',
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

/** `Netto-Grundfläche (m²)`, or just `Netto-Grundfläche` when none is declared. */
function withUnit(label: string, unit: string): string {
  return unit ? `${label} (${unit})` : label
}

/**
 * CSV for the Raumbuch — the export an architect pastes into their own sheet.
 *
 * This is the version of the Flächenaufstellung that leaves the product, so it
 * carries what the screen carries: the totals of the rows it actually wrote,
 * and every caveat attached to them.
 */
export function roomScheduleToCsv(
  schedule: BimRoomSchedule,
  options: {
    /**
     * Set when the file holds ONE storey rather than the building.
     *
     * The chat card downloads `{ ...schedule, storeys: filtered }`, and
     * `totals` came through the spread untouched — so a file called
     * "Raumbuch Erdgeschoss" ended in a row labelled `Gesamt` carrying the
     * whole building's Netto-Grundfläche. The screen guards against exactly
     * that and says so; the file that reaches the Einreichung did not.
     */
    storeyFilter?: string | null
    /** The model was read only in part, so these are not building figures. */
    truncated?: boolean
  } = {}
): string {
  const header = [
    'Geschoß',
    'Raum',
    'Kategorie',
    // The unit only when the model declared one — see `units` above. `(…)`
    // with nothing in it reads as a column whose unit went missing.
    withUnit('Netto-Grundfläche', schedule.units.area),
    withUnit('Brutto-Grundfläche', schedule.units.area),
    withUnit('Rauminhalt', schedule.units.volume),
    withUnit('Höhe', schedule.units.length),
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
    // `\r` as well as `\n`. A lone carriage return — which IFC exporters and
    // hand-edited STEP files do emit in `IfcSpace.Name` — ends a row for Excel
    // and for most CSV readers just as a newline does, so an unquoted one lets
    // an uploaded model inject whole extra rows into the Raumbuch a colleague
    // downloads: fabricated room names and areas that read as model data.
    // `\r\n` was already caught through its `\n`; the bare one was not.
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
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
  /*
    The footer is computed from the storeys WRITTEN, never from
    `schedule.totals`. Those two are the same thing for a whole-building
    export and are not for a filtered one, and the difference is a building's
    Netto-Grundfläche presented as one floor's.
  */
  const written = schedule.storeys.reduce(
    (acc, storey) => ({
      netFloorArea: add(acc.netFloorArea, storey.netFloorArea),
      grossFloorArea: add(acc.grossFloorArea, storey.grossFloorArea),
      netVolume: add(acc.netVolume, storey.netVolume),
      roomsWithoutArea: acc.roomsWithoutArea + storey.roomsWithoutArea,
    }),
    {
      netFloorArea: null as number | null,
      grossFloorArea: null as number | null,
      netVolume: null as number | null,
      roomsWithoutArea: 0,
    }
  )
  lines.push(
    [
      options.storeyFilter ? `Summe ${options.storeyFilter}` : 'Gesamt',
      '',
      '',
      round(written.netFloorArea),
      round(written.grossFloorArea),
      round(written.netVolume),
      '',
      '',
    ]
      .map(escape)
      .join(';')
  )

  /*
    And the two caveats the screen refuses to omit.

    A Flächenaufstellung that is short by four rooms, or computed over half a
    model, and does not say so is the one number in this product that could do
    real damage — and the downloaded file was the only version of it with no
    warning attached. Written as leading text in the first column so they
    survive an import into any spreadsheet.
  */
  if (options.truncated) {
    lines.push(
      escape(
        'Dieses Modell wurde nur teilweise eingelesen — die Summen oben sind keine Gebäudewerte.'
      ) + ';'.repeat(header.length - 1)
    )
  }
  if (written.roomsWithoutArea > 0) {
    lines.push(
      escape(
        `Räume ohne Flächenangabe: ${written.roomsWithoutArea} — in diesen Summen nicht enthalten.`
      ) + ';'.repeat(header.length - 1)
    )
  }

  // Semicolon-separated: the German/Austrian Excel default, where a
  // comma-separated file with decimal commas lands in one column.
  return lines.join('\n')
}
