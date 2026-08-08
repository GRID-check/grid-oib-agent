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
import { buildModelDigest, buildStoreyBreakdown } from './digest'
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
    expect(buildStoreyBreakdown(index, index.elements)).toEqual([
      { storeyName: 'Erdgeschoss', elementCount: 12, spaceCount: 2, netFloorArea: 44.5 },
      { storeyName: 'Obergeschoss', elementCount: 7, spaceCount: 2, netFloorArea: 24.5 },
    ])
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
