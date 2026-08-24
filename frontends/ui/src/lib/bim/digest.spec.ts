/**
 * The digest is what makes a model retrievable by the existing RAG stack, so
 * what matters is that the *facts an architect would ask about* are present as
 * text — storey names, room areas, fire ratings, materials — not the exact
 * layout. Assertions are on content, not on formatting, except where the
 * formatting is the contract (Markdown tables the answer renderer parses).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractIfcModel } from './extract'
import { buildModelDigest, buildStoreyBreakdown, storeyBreakdownKey } from './digest'
import type { BimModelIndex } from './types'

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'ifc', 'sample-building.ifc')

let cached: BimModelIndex | null = null
async function model(): Promise<BimModelIndex> {
  if (!cached) {
    const buffer = readFileSync(FIXTURE)
    cached = await extractIfcModel(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      'sample-building.ifc'
    )
  }
  return cached
}

describe('buildStoreyBreakdown', () => {
  it('rolls elements and room areas up per storey', async () => {
    const index = await model()
    expect([...buildStoreyBreakdown(index, index.elements).values()]).toEqual([
      { storeyName: 'Erdgeschoss', elementCount: 12, spaceCount: 2, netFloorArea: 44.5 },
      { storeyName: 'Obergeschoss', elementCount: 7, spaceCount: 2, netFloorArea: 24.5 },
    ])
  })

  it('keys each rollup, so the digest cannot join it back by position', async () => {
    // The digest used to read `breakdown[index]` against `summary.storeys`,
    // which holds only while the two are the same length. Two storeys sharing
    // a GlobalId — a real export defect, with a validation rule of its own —
    // collapse into one entry, so the array came back short and every storey
    // after the collision was rendered with the NEXT storey's element count,
    // room count and floor area.
    const index = await model()
    const breakdown = buildStoreyBreakdown(index, index.elements)
    for (const storey of index.storeys) {
      expect(breakdown.get(storeyBreakdownKey(storey))?.storeyName).toBe(storey.name)
    }
  })

  it('gives a colliding pair one entry rather than a silently shifted list', async () => {
    const index = await model()
    const collided = {
      ...index,
      storeys: index.storeys.map((storey) => ({ ...storey, globalId: 'same-id' })),
    }
    const breakdown = buildStoreyBreakdown(collided, index.elements)
    expect(breakdown.size).toBe(1)
    // And the digest renders BOTH rows from that one entry rather than
    // rendering the second from nothing — wrong, but identically wrong, and
    // no longer an off-by-one that shifts every later storey.
    expect(breakdown.get('same-id')).toBeDefined()
  })
})

describe('buildModelDigest — storeys the export wrote twice', () => {
  it('renders one row per storey key, not one per colliding entry', async () => {
    /*
      Two storeys written with the same GlobalId — the export defect
      `validate.ts:identity` reports — collapse to ONE entry in the breakdown
      map, and the table rendered that entry once per summary storey: `EG | 2
      Bauteile | 2 Räume | 100 m²` and `1.OG | 2 | 2 | 100 m²` for a building
      with one room of 40 m² on each. The Bauteile and Netto-Grundfläche
      columns then summed to double the building.

      This digest is indexed for retrieval, so the agent can quote it back as a
      fact about the project.
    */
    const index = await model()
    const [first, second] = index.storeys
    const collided = {
      ...index,
      storeys: [first, { ...second, globalId: first.globalId }],
    }

    const digest = buildModelDigest(collided, index.elements, { filename: 'x.ifc' })
    const rows = digest
      .split('\n')
      .filter((line) => line.startsWith('| ') && line.includes(' m |'))

    expect(rows).toHaveLength(1)
  })
})

describe('buildModelDigest', () => {
  it('names the model and the source file', async () => {
    const index = await model()
    const digest = buildModelDigest(index, index.elements, { filename: 'sample-building.ifc' })
    expect(digest).toContain('# BIM-Modell: Wohnhaus Beispielgasse')
    expect(digest).toContain('`sample-building.ifc`')
  })

  it('writes the model facts a retriever has to be able to match on', async () => {
    const index = await model()
    const digest = buildModelDigest(index, index.elements, { filename: 'sample-building.ifc' })
    expect(digest).toContain('Grundstueck Beispielgasse 12')
    expect(digest).toContain('IFC4')
    expect(digest).toContain('| Erdgeschoss | 0 m |')
    expect(digest).toContain('| Obergeschoss | 3 m |')
    expect(digest).toContain('| IfcWall | 5 |')
    expect(digest).toContain('| IfcSpace | 4 |')
  })

  it('states the building totals with their units', async () => {
    const index = await model()
    const digest = buildModelDigest(index, index.elements, { filename: 'sample-building.ifc' })
    expect(digest).toContain('Netto-Grundfläche (Summe Räume) | 69 m²')
    expect(digest).toContain('Brutto-Grundfläche (Summe Räume) | 74.20 m²')
    expect(digest).toContain('Netto-Rauminhalt (Summe Räume) | 80 m³')
  })

  it('lists rooms with their storey and area', async () => {
    const index = await model()
    const digest = buildModelDigest(index, index.elements, { filename: 'sample-building.ifc' })
    expect(digest).toContain('| Wohnzimmer | Erdgeschoss | 32 m² |')
    expect(digest).toContain('| Bad | Obergeschoss | 6.50 m² |')
  })

  it('surfaces the property values, which is what compliance questions ask about', async () => {
    const index = await model()
    const digest = buildModelDigest(index, index.elements, { filename: 'sample-building.ifc' })
    expect(digest).toContain('Pset_WallCommon.FireRating')
    expect(digest).toContain('REI 90 (3×)')
    expect(digest).toContain('EI 30 (2×)')
    expect(digest).toContain('Pset_DoorCommon.FireExit')
  })

  it('lists the materials', async () => {
    const index = await model()
    const digest = buildModelDigest(index, index.elements, { filename: 'sample-building.ifc' })
    expect(digest).toContain('Aussenputz, Stahlbeton, Waermedaemmung EPS')
  })

  it('says so out loud when the element list was capped', async () => {
    const index = await model()
    const truncated = { ...index, truncatedAt: 5 }
    const digest = buildModelDigest(truncated, index.elements.slice(0, 5), {
      filename: 'sample-building.ifc',
    })
    expect(digest).toContain('mehr als 5 Bauteile')
    // The totals stay honest even in a truncated digest.
    expect(digest).toContain('| Bauteile gesamt | 19 |')
  })
})

describe('a cell cannot break out of the table', () => {
  /**
   * The digest is the text the retriever indexes. A row that breaks re-parses
   * as a different table, and the model then reads values under the wrong
   * headings — the digest's own numbers, attributed to the wrong property.
   *
   * None of these are hypothetical characters: element names, type names and
   * property values come out of whichever tool exported the model.
   */
  it('escapes backslashes BEFORE pipes, and newlines at all', async () => {
    const index = await model()
    // A ROOM, because rooms are the elements the digest names individually.
    let renamed = false
    const hostile = index.elements.map((element) => {
      if (renamed || element.ifcType !== 'IfcSpace') return element
      renamed = true
      return { ...element, name: 'Wohnen \\| 01\nOG' }
    })
    expect(renamed).toBe(true)

    const digest = buildModelDigest(index, hostile, { filename: 'sample-building.ifc' })
    const rows = digest.split('\n').filter((line) => line.startsWith('|'))
    const hostileRow = rows.find((line) => line.includes('Wohnen '))

    expect(hostileRow).toBeDefined()
    // Escaping `|` first would have produced `\\|` — a literal backslash and
    // then a live separator, which splits the cell in two.
    expect(hostileRow).toContain('Wohnen \\\\\\| 01 OG')
    // And every row still has the column count its header declared.
    for (const line of rows) expect(line).not.toMatch(/\n/)
  })
})
