import { describe, expect, it } from 'vitest'
import {
  buildColorOverrides,
  buildElementIndex,
  buildExpressIdIndex,
  expressIdsForStorey,
  flattenSpatialTree,
  formatElevation,
  highlightedExpressIds,
  HIGHLIGHT_RGBA,
  resolveHighlights,
  shortIfcType,
  type BimViewerElement,
} from './model-index'
import type { BimSpatialNode } from '@/lib/bim/types'

const ELEMENTS: BimViewerElement[] = [
  { globalId: 'g-wall-1', expressId: 21, ifcType: 'IfcWall', name: 'Aussenwand Nord', storeyName: 'Erdgeschoss' },
  { globalId: 'g-wall-2', expressId: 22, ifcType: 'IfcWall', name: 'Innenwand', storeyName: 'Erdgeschoss' },
  { globalId: 'g-wall-3', expressId: 24, ifcType: 'IfcWall', name: 'Aussenwand OG', storeyName: 'Obergeschoss' },
  { globalId: 'g-space-1', expressId: 36, ifcType: 'IfcSpace', name: 'Wohnzimmer', storeyName: 'Erdgeschoss' },
]

describe('id indexes', () => {
  it('maps GlobalIds to the express ids the renderer draws by', () => {
    expect(buildExpressIdIndex(ELEMENTS).get('g-wall-1')).toBe(21)
    expect(buildElementIndex(ELEMENTS).get(36)?.name).toBe('Wohnzimmer')
  })
})

describe('resolveHighlights', () => {
  it('translates GlobalIds and reports the ones the model does not have', () => {
    const [resolved] = resolveHighlights(
      [{ globalIds: ['g-wall-1', 'g-wall-3', 'g-nonexistent'], label: 'Aussenwände', status: 'fail' }],
      ELEMENTS
    )
    expect(resolved.expressIds).toEqual([21, 24])
    // Surfaced, not swallowed: highlighting two of three elements while saying
    // nothing is a wrong answer rendered confidently.
    expect(resolved.unresolved).toEqual(['g-nonexistent'])
  })

  it('keeps groups separate so each keeps its own verdict', () => {
    const resolved = resolveHighlights(
      [
        { globalIds: ['g-wall-1'], label: 'Geprüft', status: 'pass' },
        { globalIds: ['g-wall-3'], label: 'Zu dünn', status: 'fail' },
      ],
      ELEMENTS
    )
    expect(resolved.map((group) => group.status)).toEqual(['pass', 'fail'])
  })
})

describe('buildColorOverrides', () => {
  it('colours each element by its group verdict', () => {
    const overrides = buildColorOverrides(
      resolveHighlights(
        [
          { globalIds: ['g-wall-1'], label: 'ok', status: 'pass' },
          { globalIds: ['g-wall-3'], label: 'nicht ok', status: 'fail' },
        ],
        ELEMENTS
      )
    )
    expect(overrides.get(21)).toEqual(HIGHLIGHT_RGBA.pass)
    expect(overrides.get(24)).toEqual(HIGHLIGHT_RGBA.fail)
  })

  it('lets the later group win an overlap, matching the legend’s reading order', () => {
    const overrides = buildColorOverrides(
      resolveHighlights(
        [
          { globalIds: ['g-wall-1'], label: 'geprüft', status: 'pass' },
          { globalIds: ['g-wall-1'], label: 'verletzt Abstand', status: 'fail' },
        ],
        ELEMENTS
      )
    )
    expect(overrides.get(21)).toEqual(HIGHLIGHT_RGBA.fail)
  })

  it('collects every highlighted id for framing the camera', () => {
    const ids = highlightedExpressIds(
      resolveHighlights([{ globalIds: ['g-wall-1', 'g-space-1'], label: 'x', status: 'info' }], ELEMENTS)
    )
    expect([...ids].sort((a, b) => a - b)).toEqual([21, 36])
  })
})

describe('expressIdsForStorey', () => {
  it('selects everything on one storey, case-insensitively', () => {
    expect([...(expressIdsForStorey(ELEMENTS, 'erdgeschoss') ?? [])].sort((a, b) => a - b)).toEqual([21, 22, 36])
  })

  it('returns null for no storey filter — which the renderer reads as "isolate nothing"', () => {
    // Distinct from an EMPTY set, which the renderer reads as "hide everything".
    expect(expressIdsForStorey(ELEMENTS, null)).toBeNull()
  })

  it('returns an empty set for a storey with no elements', () => {
    expect(expressIdsForStorey(ELEMENTS, 'Dachgeschoss')?.size).toBe(0)
  })
})

describe('flattenSpatialTree', () => {
  const TREE: BimSpatialNode = {
    globalId: 'g-project',
    expressId: 13,
    ifcType: 'IfcProject',
    name: 'Wohnhaus',
    elevation: null,
    elementCount: 0,
    children: [
      {
        globalId: 'g-storey-eg',
        expressId: 16,
        ifcType: 'IfcBuildingStorey',
        name: 'Erdgeschoss',
        elevation: 0,
        elementCount: 3,
        children: [
          {
            globalId: 'g-space-1',
            expressId: 36,
            ifcType: 'IfcSpace',
            name: 'Wohnzimmer',
            elevation: null,
            elementCount: 0,
            children: [],
          },
        ],
      },
    ],
  }

  it('flattens depth-first with a depth column', () => {
    expect(flattenSpatialTree(TREE).map((row) => [row.depth, row.label])).toEqual([
      [0, 'Wohnhaus'],
      [1, 'Erdgeschoss'],
      [2, 'Wohnzimmer'],
    ])
  })

  it('marks only storeys as filterable, since only they isolate a level', () => {
    expect(flattenSpatialTree(TREE).map((row) => row.storeyName)).toEqual([null, 'Erdgeschoss', null])
  })

  it('is empty for a model with no spatial structure', () => {
    expect(flattenSpatialTree(null)).toEqual([])
  })
})

describe('formatting', () => {
  it('signs elevations so a basement reads as one', () => {
    expect(formatElevation({ elevation: 0 })).toBe('0 m')
    expect(formatElevation({ elevation: 3.2 })).toBe('+3.2 m')
    expect(formatElevation({ elevation: -2.85 })).toBe('-2.85 m')
    expect(formatElevation({ elevation: null })).toBe('—')
  })

  it('drops the Ifc prefix for table display but leaves other names alone', () => {
    expect(shortIfcType('IfcWall')).toBe('Wall')
    expect(shortIfcType('Wall')).toBe('Wall')
  })
})
