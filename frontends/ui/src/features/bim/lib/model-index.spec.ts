import { describe, expect, it } from 'vitest'
import {
  buildColorOverrides,
  buildElementIndex,
  buildExpressIdIndex,
  expressIdsForStorey,
  flattenSpatialTree,
  formatElevation,
  hasVisibilityEdits,
  highlightedExpressIds,
  HIGHLIGHT_RGBA,
  NOTHING_HIDDEN,
  resolveHighlights,
  resolveIsolation,
  selectionSurvives,
  shortIfcType,
  storeyKey,
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
    // The model DOES assign elements to storeys and none are on this one, so
    // an empty viewport is the correct answer to the question asked.
    expect(expressIdsForStorey(ELEMENTS, 'Dachgeschoss')?.size).toBe(0)
  })

  it('does not blank the building while the element rows are still in flight', () => {
    // Geometry and the element list arrive on separate requests. A link
    // carrying `?storey=Erdgeschoss` renders the building a beat before the
    // rows land, and an empty set in that window means "draw nothing" — the
    // reader watches their model disappear and come back.
    expect(expressIdsForStorey([], 'Erdgeschoss')).toBeNull()
  })

  it('does not blank the building when the model assigns no storeys at all', () => {
    // Matching by name cannot be done, which is a fact about the export. It is
    // not the same fact as "this level is empty", and hiding the whole
    // building is not a truthful way to report it.
    const unassigned: BimViewerElement[] = [
      { globalId: 'g-1', expressId: 1, ifcType: 'IfcWall', name: 'Wand', storeyName: null },
      { globalId: 'g-2', expressId: 2, ifcType: 'IfcSlab', name: 'Decke', storeyName: null },
    ]
    expect(expressIdsForStorey(unassigned, 'Erdgeschoss')).toBeNull()
  })
})

describe('what the viewport finally isolates', () => {
  it('leaves the building alone when neither constraint is live', () => {
    expect(resolveIsolation(null, null)).toBeNull()
  })

  it('honours either constraint on its own', () => {
    expect([...(resolveIsolation(new Set([1, 2]), null) ?? [])]).toEqual([1, 2])
    expect([...(resolveIsolation(null, new Set([3])) ?? [])]).toEqual([3])
  })

  it('takes BOTH when the reader asked for both', () => {
    // Isolate a stair, filter to the first floor: the answer is the part of
    // the stair on that floor, not one or the other.
    expect([...(resolveIsolation(new Set([1, 2, 3]), new Set([2, 3, 9])) ?? [])]).toEqual([2, 3])
  })

  it('passes an empty intersection through rather than dropping a constraint', () => {
    // The reader isolated something that is not on the level they filtered to.
    // An empty viewport is the honest report; quietly ignoring one control
    // would show them a building they did not ask for.
    expect(resolveIsolation(new Set([1]), new Set([2]))?.size).toBe(0)
  })
})

describe('whether a selection survives being hidden', () => {
  it('drops a selection the reader just hid', () => {
    // Otherwise the inspector describes a component that is not on screen and
    // the camera orbits around something invisible.
    expect(selectionSurvives(21, { hidden: new Set([21]), isolated: null })).toBe(false)
  })

  it('drops a selection that isolation excluded', () => {
    expect(selectionSurvives(21, { hidden: new Set(), isolated: new Set([22]) })).toBe(false)
  })

  it('keeps a selection that is still visible', () => {
    expect(selectionSurvives(21, { hidden: new Set([22]), isolated: new Set([21]) })).toBe(true)
    expect(selectionSurvives(21, NOTHING_HIDDEN)).toBe(true)
  })

  it('has nothing to keep when nothing is selected', () => {
    expect(selectionSurvives(null, NOTHING_HIDDEN)).toBe(false)
  })
})

describe('whether the reader has changed what is visible', () => {
  it('is false on a untouched viewport', () => {
    expect(hasVisibilityEdits(NOTHING_HIDDEN)).toBe(false)
  })

  it('is true once anything is hidden or isolated', () => {
    expect(hasVisibilityEdits({ hidden: new Set([1]), isolated: null })).toBe(true)
    // An EMPTY isolation set is still an edit — it is the state where the
    // reader isolated a thing that no longer resolves, and they need the way
    // out that "show everything" is.
    expect(hasVisibilityEdits({ hidden: new Set(), isolated: new Set() })).toBe(true)
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
    expect(formatElevation({ elevation: 0 }, 'en-GB')).toBe('0 m')
    expect(formatElevation({ elevation: 3.2 }, 'en-GB')).toBe('+3.2 m')
    expect(formatElevation({ elevation: -2.85 }, 'en-GB')).toBe('-2.85 m')
    // `+3.25 m` in a German Struktur tree reads as 325 metres.
    expect(formatElevation({ elevation: -2.85 }, 'de-AT')).toBe('-2,85 m')
    expect(formatElevation({ elevation: null }, 'en-GB')).toBe('—')
  })

  it('drops the Ifc prefix for table display but leaves other names alone', () => {
    expect(shortIfcType('IfcWall')).toBe('Wall')
    expect(shortIfcType('Wall')).toBe('Wall')
  })
})

describe('one storey name, compared one way', () => {
  it('ignores the padding an exporter left on the name', () => {
    // Trailing whitespace in an IFC storey name is common. The rail publishes
    // `name.trim()` and writes that into the link, while every element carries
    // the padded original — so nothing matched, the model DOES assign storeys,
    // and the answer was an empty set. The renderer reads that as "draw
    // nothing": the app's own rail blanked the building.
    const padded: BimViewerElement[] = [
      { globalId: 'g-1', expressId: 1, ifcType: 'IfcWall', name: 'Wand', storeyName: ' Erdgeschoss ' },
    ]
    expect([...(expressIdsForStorey(padded, 'Erdgeschoss') ?? [])]).toEqual([1])
  })

  it('reduces case and padding to one key', () => {
    expect(storeyKey('  ErdGeschoss ')).toBe('erdgeschoss')
    expect(storeyKey(null)).toBe('')
  })
})
