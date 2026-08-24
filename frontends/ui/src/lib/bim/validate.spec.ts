/**
 * The validator, against the real fixture and against models built to be
 * broken in one specific way each.
 *
 * The assertion that matters most is not "the rule fires" — it is that a rule
 * which fires changes what the AGENT is allowed to say. `healthCaveat` is
 * tested as the contract it is: the sentence an answer over a defective model
 * has to carry.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractIfcModel } from './extract'
import { healthCaveat, validateModel, type BimIssueRule } from './validate'
import type { BimElement, BimModelIndex } from './types'

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

function element(overrides: Partial<BimElement> = {}): BimElement {
  return {
    globalId: '0GridFixture00Wall0001',
    expressId: 21,
    ifcType: 'IfcWall',
    name: 'Aussenwand',
    description: null,
    predefinedType: null,
    objectType: null,
    tag: null,
    typeName: null,
    containerKind: 'storey',
    containerGlobalId: 'g-eg',
    containerName: 'Erdgeschoss',
    storeyGlobalId: 'g-eg',
    storeyName: 'Erdgeschoss',
    materials: ['Stahlbeton'],
    classifications: [{ system: 'ON', identification: 'B.1', name: 'Wand' }],
    properties: { Pset_WallCommon: { IsExternal: true } },
    quantities: { Qto_WallBaseQuantities: { NetSideArea: 10 } },
    ...overrides,
  }
}

function index(elements: BimElement[], overrides: Partial<BimModelIndex> = {}): BimModelIndex {
  return {
    unreadableEntities: 0,
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
    units: { length: null, area: null, volume: null },
    projectName: null,
    siteName: null,
    buildingNames: [],
    storeys: [{ globalId: 'g-eg', expressId: 16, name: 'Erdgeschoss', elevation: 0, elementCount: 1 }],
    spatial: null,
    typeCounts: {},
    propertySetNames: [],
    quantitySetNames: [],
    materialNames: [],
    totals: { entities: 1, elements: elements.length, spaces: 0, storeys: 1 },
    quantityTotals: { netFloorAreaM2: null, grossFloorAreaM2: null, netVolumeM3: null },
    health: null,
    parseMs: 1,
    fileSizeBytes: 1,
    truncatedAt: null,
    elements,
    ...overrides,
  }
}

const rules = (model: BimModelIndex): BimIssueRule[] =>
  validateModel(model).issues.map((issue) => issue.rule)

describe('validateModel on a well-formed model', () => {
  it('finds nothing structural in the fixture', async () => {
    const health = (await model()).health
    expect(health).not.toBeNull()
    expect(health?.totals.error).toBe(0)
    // The fixture deliberately publishes no quantities on doors/windows and no
    // Pset_SpaceCommon, so warnings are expected — errors are not.
    expect(health?.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  })

  it('runs at ingestion, so the report travels with the model', async () => {
    // Computed over the FULL extraction: a truncated element list must not be
    // able to make a model look healthier than it is.
    expect((await model()).health?.score).toBeGreaterThan(0)
  })
})

describe('stage 1 — schema', () => {
  it('reports an undeclared schema as a warning, not a failure', () => {
    // The parser read the file regardless; what is lost is the ability to say
    // whether an entity is valid in that version.
    expect(rules(index([element()], { schema: null }))).toContain('schema-unknown')
  })

  it('notes IFC2X3 as information, because it is legal and merely old', () => {
    const health = validateModel(index([element()], { schema: 'IFC2X3' }))
    const issue = health.issues.find((entry) => entry.rule === 'schema-legacy')
    expect(issue?.severity).toBe('info')
    expect(issue?.detail).toBe('IFC2X3')
  })
})

describe('stage 2 — identity', () => {
  it('flags a duplicated GlobalId as an error', () => {
    const found = rules(index([element(), element({ expressId: 22 })]))
    // Two elements with one id makes "which element is that" unanswerable, and
    // makes a revision comparison silently wrong.
    expect(found).toContain('identity-duplicate-globalid')
  })

  it('flags an element the file failed to identify at all', () => {
    expect(rules(index([element({ globalId: 'express:21' })]))).toContain('identity-missing-globalid')
  })

  it('flags a GlobalId that is not in the 22-character IFC form', () => {
    expect(rules(index([element({ globalId: 'not-a-guid' })]))).toContain(
      'identity-malformed-globalid'
    )
  })
})

describe('stage 3 — spatial structure', () => {
  it('treats an unplaced element as an ERROR, because it breaks every count', () => {
    const health = validateModel(
      index([element(), element({ expressId: 22, globalId: '0GridFixture00Wall0002', containerKind: null, storeyGlobalId: null })])
    )
    const issue = health.issues.find((entry) => entry.rule === 'spatial-orphan-elements')
    expect(issue?.severity).toBe('error')
    expect(issue?.count).toBe(1)
    expect(issue?.total).toBe(2)
    expect(issue?.sampleGlobalIds).toEqual(['0GridFixture00Wall0002'])
  })

  it('flags an element parked on the site or the building instead of a storey', () => {
    expect(rules(index([element({ containerKind: 'building' })]))).toContain(
      'spatial-element-above-storey'
    )
  })

  it('flags a model with no storeys at all', () => {
    expect(rules(index([element()], { storeys: [] }))).toContain('spatial-no-storeys')
  })

  it('flags two storeys sharing an elevation', () => {
    const found = rules(
      index([element()], {
        storeys: [
          { globalId: 'a', expressId: 1, name: 'EG', elevation: 0, elementCount: 0 },
          { globalId: 'b', expressId: 2, name: 'EG alt', elevation: 0, elementCount: 0 },
        ],
      })
    )
    // "The storey above" is unanswerable when two are at the same height.
    expect(found).toContain('spatial-duplicate-storey-elevation')
  })

  it('flags a storey with no elevation', () => {
    const found = rules(
      index([element()], {
        storeys: [{ globalId: 'a', expressId: 1, name: 'EG', elevation: null, elementCount: 0 }],
      })
    )
    expect(found).toContain('spatial-storey-without-elevation')
  })
})

describe('stage 4 — property sets', () => {
  it('names the type and the set that is missing, not just a total', () => {
    const health = validateModel(index([element({ properties: { Vendor_Attributes: { A: 1 } } })]))
    const issue = health.issues.find((entry) => entry.rule === 'properties-missing-common-pset')
    expect(issue?.detail).toBe('IfcWall · Pset_WallCommon')
    expect(issue?.count).toBe(1)
  })

  it('escalates to an error only when NOTHING has a property set', () => {
    const none = validateModel(index([element({ properties: {} })]))
    expect(none.issues.find((entry) => entry.rule === 'properties-no-property-sets')?.severity).toBe(
      'error'
    )

    const some = validateModel(index([element(), element({ expressId: 22, globalId: '0GridFixture00Wall0002', properties: {} })]))
    expect(some.issues.find((entry) => entry.rule === 'properties-no-property-sets')?.severity).toBe(
      'warning'
    )
  })

  it('notes a model whose property sets are all vendor-specific', () => {
    // Such a model answers questions — but only in a vocabulary no regulation
    // is written in.
    expect(rules(index([element({ properties: { ArchiCADProperties: { X: 1 } } })]))).toContain(
      'properties-vendor-sets-only'
    )
  })
})

describe('stage 5 — completeness', () => {
  it('flags rooms that publish no area, which is what makes an area total short', () => {
    const space = element({
      ifcType: 'IfcSpace',
      globalId: '0GridFixture00Space001',
      quantities: {},
      properties: { Pset_SpaceCommon: {} },
    })
    const health = validateModel(index([space]))
    const issue = health.issues.find((entry) => entry.rule === 'complete-space-without-area')
    expect(issue?.severity).toBe('warning')
    expect(issue?.count).toBe(1)
  })

  it('reports absent information as info, not as a defect', () => {
    const health = validateModel(index([element({ classifications: [] })]))
    const issue = health.issues.find((entry) => entry.rule === 'complete-no-classifications')
    // A model without classifications is not broken; it just cannot answer
    // questions about classifications.
    expect(issue?.severity).toBe('info')
  })
})

describe('score', () => {
  it('is 100 for a model with nothing to report', () => {
    expect(validateModel(index([element()])).score).toBe(100)
  })

  it('scales with how much of the model a rule affects, not merely that it fired', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      element({ expressId: 100 + i, globalId: `0GridFixtureWall00${String(i).padStart(2, '0')}` })
    )
    const oneOrphan = validateModel(
      index([...many, element({ expressId: 200, globalId: '0GridFixtureWall0200', containerKind: null, storeyGlobalId: null })])
    ).score
    const allOrphans = validateModel(
      index(many.map((entry) => ({ ...entry, containerKind: null, storeyGlobalId: null })))
    ).score
    expect(allOrphans).toBeLessThan(oneOrphan)
  })
})

describe('healthCaveat', () => {
  it('is null when there is nothing an answer needs to qualify', () => {
    expect(healthCaveat(validateModel(index([element()])))).toBeNull()
  })

  it('states how many elements a per-storey answer leaves out', () => {
    const health = validateModel(
      index([element(), element({ expressId: 22, globalId: '0GridFixture00Wall0002', containerKind: null, storeyGlobalId: null })])
    )
    expect(healthCaveat(health)).toContain('1 Bauteile sind keinem Geschoß zugeordnet')
  })

  it('states how many rooms are missing from an area total', () => {
    const health = validateModel(
      index([
        element({ ifcType: 'IfcSpace', globalId: '0GridFixture00Space001', quantities: {} }),
        element({
          ifcType: 'IfcSpace',
          expressId: 37,
          globalId: '0GridFixture00Space002',
          quantities: { Qto_SpaceBaseQuantities: { NetFloorArea: 12 } },
        }),
      ])
    )
    expect(healthCaveat(health)).toContain('1 von 2 Räumen veröffentlichen keine Fläche')
  })

  it('ignores info-level gaps, which change no number', () => {
    const health = validateModel(index([element({ classifications: [], materials: [] })]))
    expect(healthCaveat(health)).toBeNull()
  })
})
