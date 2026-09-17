import { describe, expect, test } from 'vitest'
import {
  hasStructuredDetail,
  humanizeTerm,
  normalizeDrawingStructured,
  type DrawingStructured,
} from './drawing-structured'

/** A payload shaped exactly as the extraction schema writes it. */
const RAW = {
  schema_version: 4,
  registry: 'architecture+general@850c9b2d770a',
  segment: {
    domain: 'architecture',
    segment_type: 'floor_plan',
    title: 'EG',
    scale: '1:100',
    summary: 'Grundriss des Erdgeschosses.',
    entities: [
      { name: 'Atelier', category: 'space', role: 'Arbeiten', measure: '24,5 m²' },
      { name: 'Technikraum', category: 'space', role: null, measure: null },
      { name: 'Wärmepumpe', category: 'services', role: null, measure: null },
      // A nameless entity carries nothing.
      { name: '', category: 'space', role: 'leer', measure: null },
    ],
    compositions: [
      {
        component: 'Außenwand',
        layers: [{ material: 'Stahlbeton', thickness: '20 cm', function: 'tragend' }],
      },
    ],
    states: [{ element: 'Bestandsmauer', state: 'existing' }],
    quantities: [
      {
        object: 'Bausubstanz erhalten',
        property: 'Anteil',
        value: '71',
        unit: '%',
        source: 'text',
        confidence: 'high',
      },
      // Meaningless without an object — the schema drops these, and so must we.
      { object: '', property: 'x', value: '9', unit: null, source: null, confidence: null },
    ],
    relations: [{ subject: 'Rampe', relation: 'verbindet', object: 'Hof und Dach' }],
    annotations: ['5,40'],
    source: 'visual',
    confidence: 'medium',
  },
  document: {
    title: 'Bildungscampus',
    subtitle: 'Transformation',
    slogans: ['ABRISS STOPPEN'],
    author: 'N.N.',
    institution: 'TU Wien',
    supervision: null,
    location: 'Linz',
    strategies: ['Bestandserhalt'],
    process_steps: ['Abriss stoppen', 'transformieren'],
  },
}

describe('normalizeDrawingStructured', () => {
  test('maps the extraction schema onto the display shape', () => {
    const result = normalizeDrawingStructured(RAW) as DrawingStructured

    expect(result.schemaVersion).toBe(4)
    expect(result.registry).toBe('architecture+general@850c9b2d770a')
    expect(result.segment.domain).toBe('architecture')
    expect(result.segment.segmentType).toBe('floor_plan')
    expect(result.segment.scale).toBe('1:100')
    expect(result.document.title).toBe('Bildungscampus')
    expect(result.document.processSteps).toEqual(['Abriss stoppen', 'transformieren'])
  })

  test('groups entities by category, whatever the categories are', () => {
    // The UI must not know a domain's vocabulary: a category it has never seen
    // still groups and still renders.
    const result = normalizeDrawingStructured({
      segment: {
        entities: [
          { name: 'Kran', category: 'plant' },
          { name: 'Bagger', category: 'plant' },
          { name: 'Stahlbeton', category: 'material' },
        ],
      },
    }) as DrawingStructured

    expect(result.segment.entityGroups).toEqual([
      {
        category: 'plant',
        entities: [
          { name: 'Kran', category: 'plant', role: null, measure: null },
          { name: 'Bagger', category: 'plant', role: null, measure: null },
        ],
      },
      {
        category: 'material',
        entities: [{ name: 'Stahlbeton', category: 'material', role: null, measure: null }],
      },
    ])
  })

  test('drops entries the schema treats as meaningless', () => {
    const result = normalizeDrawingStructured(RAW) as DrawingStructured

    // A nameless entity and an object-less quantity carry no information.
    const spaces = result.segment.entityGroups.find((group) => group.category === 'space')
    expect(spaces?.entities.map((entity) => entity.name)).toEqual(['Atelier', 'Technikraum'])
    expect(result.segment.quantities).toHaveLength(1)
    expect(result.segment.quantities[0].object).toBe('Bausubstanz erhalten')
  })

  test('renames the composition layer `function` field once, at the boundary', () => {
    const result = normalizeDrawingStructured(RAW) as DrawingStructured
    expect(result.segment.compositions[0].layers[0]).toEqual({
      material: 'Stahlbeton',
      thickness: '20 cm',
      purpose: 'tragend',
    })
  })

  test('a numeric vocabulary term is not a term', () => {
    const result = normalizeDrawingStructured({
      segment: { segment_type: 42, domain: 7, entities: [{ name: 'X', category: 9 }] },
    }) as DrawingStructured

    expect(result.segment.segmentType).toBe('other')
    expect(result.segment.domain).toBe('general')
    expect(result.segment.entityGroups[0].category).toBe('other')
  })

  test('returns null for anything without a segment', () => {
    expect(normalizeDrawingStructured(null)).toBeNull()
    expect(normalizeDrawingStructured(undefined)).toBeNull()
    expect(normalizeDrawingStructured('nope')).toBeNull()
    expect(normalizeDrawingStructured({})).toBeNull()
    expect(normalizeDrawingStructured({ segment: {} })).toBeNull()
  })

  test('never throws on a malformed payload', () => {
    const junk = {
      schema_version: 'four',
      segment: { entities: 'not-a-list', quantities: [null, 7], compositions: [{}], states: 'no' },
      document: 'not-an-object',
    }
    const result = normalizeDrawingStructured(junk) as DrawingStructured

    expect(result.schemaVersion).toBe(0)
    expect(result.segment.entityGroups).toEqual([])
    expect(result.segment.quantities).toEqual([])
    expect(result.segment.states).toEqual([])
    expect(result.document.title).toBeNull()
  })
})

describe('humanizeTerm', () => {
  test('reads a vocabulary key this build has no label for', () => {
    // The fallback that lets a backend domain ship without a frontend release.
    expect(humanizeTerm('building_physics')).toBe('Building physics')
    expect(humanizeTerm('space')).toBe('Space')
    expect(humanizeTerm('')).toBe('')
  })
})

describe('hasStructuredDetail', () => {
  test('true when there is more than the free-text summary', () => {
    expect(hasStructuredDetail(normalizeDrawingStructured(RAW))).toBe(true)
  })

  test('false when the payload only repeats the description', () => {
    // The summary is already rendered above the disclosure, so a segment
    // carrying nothing else must not offer an empty one to open.
    const summaryOnly = normalizeDrawingStructured({
      segment: { domain: 'general', segment_type: 'photo', summary: 'Ein Baustellenfoto.' },
      document: {},
    })
    expect(hasStructuredDetail(summaryOnly)).toBe(false)
  })

  test('false for a missing payload', () => {
    expect(hasStructuredDetail(null)).toBe(false)
  })
})
