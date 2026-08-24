/**
 * Raumbuch and Massenermittlung.
 *
 * These numbers go into a submission and a cost estimate, so the assertions are
 * about the two ways a total can lie: a missing area silently becoming zero,
 * and a room the storey order forgot silently disappearing.
 */

import { describe, expect, it } from 'vitest'
import { buildQuantityTakeoff, buildRoomSchedule, roomScheduleToCsv } from './schedule'
import type { BimElement, BimModelSummary } from './types'

function space(name: string, storeyName: string, quantities: Record<string, number> = {}): BimElement {
  return {
    globalId: `g-${name}`,
    expressId: name.length,
    ifcType: 'IfcSpace',
    name,
    description: null,
    predefinedType: 'INTERNAL',
    objectType: null,
    tag: null,
    typeName: null,
    containerKind: 'storey',
    containerGlobalId: null,
    containerName: storeyName,
    storeyGlobalId: `s-${storeyName}`,
    storeyName,
    materials: [],
    classifications: [],
    properties: {},
    quantities: Object.keys(quantities).length ? { Qto_SpaceBaseQuantities: quantities } : {},
  }
}

function wall(name: string, material: string | null, area: number | null): BimElement {
  return {
    ...space(name, 'Erdgeschoss'),
    ifcType: 'IfcWall',
    materials: material ? [material] : [],
    quantities: area === null ? {} : { Qto_WallBaseQuantities: { NetSideArea: area } },
  }
}

const SUMMARY: BimModelSummary = {
  schema: 'IFC4',
  header: {
    name: null,
    timeStamp: null,
    author: [],
    organization: [],
    preprocessorVersion: null,
    originatingSystem: null,
    description: [],
  },
  units: { length: null, area: { symbol: 'm²', siScale: 1 }, volume: { symbol: 'm³', siScale: 1 } },
  projectName: null,
  siteName: null,
  buildingNames: [],
  storeys: [
    { globalId: 's-Erdgeschoss', expressId: 1, name: 'Erdgeschoss', elevation: 0, elementCount: 2 },
    { globalId: 's-Obergeschoss', expressId: 2, name: 'Obergeschoss', elevation: 3, elementCount: 1 },
  ],
  spatial: null,
  typeCounts: {},
  propertySetNames: [],
  quantitySetNames: [],
  materialNames: [],
  totals: { entities: 0, elements: 3, spaces: 3, storeys: 2 },
  quantityTotals: { netFloorAreaM2: null, grossFloorAreaM2: null, netVolumeM3: null },
  health: null,
  parseMs: 1,
  fileSizeBytes: 1,
  truncatedAt: null,
}

describe('buildRoomSchedule', () => {
  const ROOMS = [
    space('Wohnzimmer', 'Erdgeschoss', { NetFloorArea: 32, GrossFloorArea: 34.5, NetVolume: 80 }),
    space('Kueche', 'Erdgeschoss', { NetFloorArea: 12.5 }),
    space('Schlafzimmer', 'Obergeschoss', { NetFloorArea: 18 }),
  ]

  it('groups by storey in storey order, not alphabetically', () => {
    const schedule = buildRoomSchedule(SUMMARY, ROOMS)
    expect(schedule.storeys.map((entry) => entry.storeyName)).toEqual(['Erdgeschoss', 'Obergeschoss'])
    expect(schedule.storeys[0].rooms.map((room) => room.name)).toEqual(['Kueche', 'Wohnzimmer'])
  })

  it('totals per storey and for the building', () => {
    const schedule = buildRoomSchedule(SUMMARY, ROOMS)
    expect(schedule.storeys[0].netFloorArea).toBe(44.5)
    expect(schedule.totals.netFloorArea).toBe(62.5)
    expect(schedule.totals.rooms).toBe(3)
  })

  it('keeps an absent volume absent rather than adding zero', () => {
    const schedule = buildRoomSchedule(SUMMARY, ROOMS)
    // Only the Wohnzimmer publishes a volume; the storey total is that volume,
    // not that volume plus a zero for the Küche.
    expect(schedule.storeys[0].netVolume).toBe(80)
    expect(schedule.storeys[1].netVolume).toBeNull()
  })

  it('counts the rooms a total leaves out', () => {
    const schedule = buildRoomSchedule(SUMMARY, [...ROOMS, space('Bad', 'Erdgeschoss')])
    expect(schedule.storeys[0].roomsWithoutArea).toBe(1)
    expect(schedule.totals.roomsWithoutArea).toBe(1)
    // The room is still listed — it exists, it just has no area.
    expect(schedule.storeys[0].rooms.map((room) => room.name)).toContain('Bad')
  })

  it('keeps a room whose storey the summary never named', () => {
    // Dropping it would make the building total quietly disagree with the room
    // count on the same screen.
    const schedule = buildRoomSchedule(SUMMARY, [...ROOMS, space('Technik', 'Dachboden', { NetFloorArea: 8 })])
    expect(schedule.storeys.map((entry) => entry.storeyName)).toEqual([
      'Erdgeschoss',
      'Obergeschoss',
      'Dachboden',
    ])
    expect(schedule.totals.netFloorArea).toBe(70.5)
  })

  it('exports a semicolon CSV with per-storey and grand totals', () => {
    const csv = roomScheduleToCsv(buildRoomSchedule(SUMMARY, ROOMS))
    const lines = csv.split('\n')
    expect(lines[0]).toContain('Geschoß;Raum;Kategorie;Netto-Grundfläche (m²)')
    expect(csv).toContain('Erdgeschoss;Wohnzimmer;INTERNAL;32;34,5;80;;g-Wohnzimmer')
    // Comma decimals: the separator was already chosen for German-locale
    // Excel, and `24.5` in such a file is read as TEXT — the downloaded
    // Raumbuch would not sum, which is the one thing anyone downloads it for.
    expect(csv).toContain('Erdgeschoss — Summe;;;44,5')
    expect(lines.at(-1)).toContain('Gesamt;;;62,5')
  })

  it('counts a room once when two storeys share a name', () => {
    /*
      A Wohnhausanlage exported as one IFC carries an `IfcBuildingStorey` named
      `Erdgeschoß` under each `IfcBuilding`. Rooms are bucketed by storey NAME,
      and the storey loop pushed a block for every summary entry resolving to
      that bucket — so both blocks held the same rooms and the building total
      counted them twice. Two rooms of 40 and 60 m² came out as "4 Räume,
      200 m²", which is the Netto-Grundfläche an architect copies into a
      Flächenaufstellung.
    */
    const summary = {
      ...SUMMARY,
      storeys: [
        { globalId: 'S1', name: 'Erdgeschoss', elevation: 0, expressId: 10, elementCount: 0 },
        { globalId: 'S2', name: 'Erdgeschoss', elevation: 0, expressId: 20, elementCount: 0 },
      ],
    } as typeof SUMMARY
    const schedule = buildRoomSchedule(summary, [
      space('Wohnen A', 'Erdgeschoss', { NetFloorArea: 40 }),
      space('Wohnen B', 'Erdgeschoss', { NetFloorArea: 60 }),
    ])

    expect(schedule.totals.rooms).toBe(2)
    expect(schedule.totals.netFloorArea).toBe(100)
    expect(schedule.storeys).toHaveLength(1)
  })

  it('does not label a single storey\u2019s sum as the building total', () => {
    /*
      The chat card downloads `{ ...schedule, storeys: filtered }` and `totals`
      came through the spread untouched — so a file called "Raumbuch
      Erdgeschoss" ended in a row labelled `Gesamt` carrying the whole
      building's Netto-Grundfläche. The screen guards against exactly this and
      says so in a comment; the file that reaches the Einreichung did not.
    */
    const whole = buildRoomSchedule(SUMMARY, ROOMS)
    const oneFloor = whole.storeys.filter((entry) => entry.storeyName === 'Erdgeschoss')
    const csv = roomScheduleToCsv(
      { ...whole, storeys: oneFloor },
      { storeyFilter: 'Erdgeschoss' }
    )

    expect(csv).toContain('Summe Erdgeschoss;;;44,5')
    // 62,5 is the building. It must not appear in a one-storey file at all.
    expect(csv).not.toContain('62,5')
    expect(csv).not.toContain('Gesamt')
  })

  it('carries the caveats that are mandatory on screen into the file', () => {
    // The downloaded Raumbuch was the one version of this Flächenaufstellung
    // with no warning attached to it.
    const csv = roomScheduleToCsv(
      buildRoomSchedule(SUMMARY, [...ROOMS, space('Bad', 'Erdgeschoss')]),
      { truncated: true }
    )
    expect(csv).toContain('Dieses Modell wurde nur teilweise eingelesen')
    expect(csv).toContain('Räume ohne Flächenangabe: 1')
  })

  it('sums the published values, not their rounded display forms', () => {
    // Each room is rounded to two decimals for the table; adding the ROUNDED
    // figures accumulates up to half a centipoint per room, so on a large
    // building the Raumbuch total drifted away from the Kennwerte
    // Netto-Grundfläche computed off the same model — with nothing on either
    // screen to explain the difference.
    const thirds = Array.from({ length: 3 }, (_, index) =>
      space(`R${index}`, 'Erdgeschoss', { NetFloorArea: 10.005 })
    )
    const schedule = buildRoomSchedule(SUMMARY, thirds)

    // 3 × 10.005 = 30.015 → 30.02, not 3 × 10.01 = 30.03.
    expect(schedule.storeys[0].netFloorArea).toBe(30.02)
    expect(schedule.totals.netFloorArea).toBe(30.02)
    // The ROWS still read as they always did.
    expect(schedule.storeys[0].rooms[0].netFloorArea).toBe(10.01)
  })

  it('escapes a room name containing the separator', () => {
    const csv = roomScheduleToCsv(buildRoomSchedule(SUMMARY, [space('Bad; WC', 'Erdgeschoss', { NetFloorArea: 6 })]))
    expect(csv).toContain('"Bad; WC"')
  })

  it('does not let a room name become a formula in the spreadsheet it targets', () => {
    // Room names come out of an uploaded IFC. A leading `=`, `+`, `-` or `@`
    // makes Excel evaluate the cell — in the German-locale spreadsheet this
    // export exists for, opened by whoever the Raumbuch was sent to. The
    // apostrophe is Excel's own "this is text" marker and does not show.
    const csv = roomScheduleToCsv(
      buildRoomSchedule(SUMMARY, [space('=HYPERLINK("http://x","Bad")', 'Erdgeschoss', { NetFloorArea: 6 })])
    )
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).not.toMatch(/;=HYPERLINK/)
  })

  it('quotes a room name holding a bare carriage return, so it cannot forge rows', () => {
    // Excel and most CSV readers end a row on a lone `\r` exactly as on `\n`.
    // Unquoted, a name out of an uploaded IFC could therefore write its own
    // extra lines into the Raumbuch a colleague downloads — invented rooms
    // with invented areas, indistinguishable from model data. `\r\n` was
    // already caught through its `\n`; the bare one was not.
    const csv = roomScheduleToCsv(
      buildRoomSchedule(SUMMARY, [
        space('Bad\rZ99;Erfundener Raum;;999', 'Erdgeschoss', { NetFloorArea: 6 }),
      ])
    )
    expect(csv).toContain('"Bad\rZ99;Erfundener Raum;;999"')
    // And no more rows than the same room with an ordinary name produces.
    const benign = roomScheduleToCsv(
      buildRoomSchedule(SUMMARY, [space('Bad', 'Erdgeschoss', { NetFloorArea: 6 })])
    )
    expect(csv.split('\n')).toHaveLength(benign.split('\n').length)
  })

  it('still writes a negative number as a number, not as text', () => {
    // The guard is for STRINGS. A `-2.5` in a numeric column is a value the
    // spreadsheet has to be able to sum; prefixing it would break the one
    // thing a downloaded Raumbuch is for.
    const csv = roomScheduleToCsv(
      buildRoomSchedule(SUMMARY, [space('Keller', 'Erdgeschoss', { NetFloorArea: -2.5 })])
    )
    expect(csv).toContain(';-2,5;')
    expect(csv).not.toContain("'-2,5")
  })
})

describe('buildQuantityTakeoff', () => {
  const WALLS = [
    wall('W1', 'Stahlbeton', 24.5),
    wall('W2', 'Stahlbeton', 22),
    wall('W3', 'Ziegel', 10),
    wall('W4', null, null),
  ]

  it('sums one quantity per element type', () => {
    expect(buildQuantityTakeoff(WALLS, { quantity: 'NetSideArea' })).toEqual([
      { group: 'IfcWall', elements: 4, value: 56.5, missing: 1 },
    ])
  })

  it('splits by primary material for a cost estimate', () => {
    const rows = buildQuantityTakeoff(WALLS, { quantity: 'NetSideArea', byMaterial: true })
    expect(rows).toEqual([
      { group: 'IfcWall · Stahlbeton', elements: 2, value: 46.5, missing: 0 },
      { group: 'IfcWall · Ziegel', elements: 1, value: 10, missing: 0 },
      { group: 'IfcWall · (ohne Material)', elements: 1, value: null, missing: 1 },
    ])
  })

  it('reports how many elements publish nothing, beside the sum', () => {
    // "56.5 m² of wall" over a set where one wall publishes no area is a
    // different number from the same figure over a complete one, and only one
    // of them belongs in a submission.
    const [row] = buildQuantityTakeoff(WALLS, { quantity: 'NetSideArea' })
    expect(row.missing).toBe(1)
    expect(row.elements).toBe(4)
  })

  it('yields a null sum rather than zero when nothing publishes the quantity', () => {
    const [row] = buildQuantityTakeoff(WALLS, { quantity: 'GrossVolume' })
    expect(row.value).toBeNull()
    expect(row.missing).toBe(4)
  })
})
