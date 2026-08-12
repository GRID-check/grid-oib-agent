/**
 * Revision series.
 *
 * Two failure modes matter here and both are silent. Merging two buildings into
 * one series produces deltas between unrelated models — "−340 elements" for a
 * building nobody touched. Failing to merge a real series produces no timeline
 * at all, which is the state the product is trying to leave. So the assertions
 * are mostly about which names group and which deliberately do not.
 */

import { describe, expect, it } from 'vitest'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import type { BimModelSummary } from '@/lib/bim/types'
import { findRevisionSeries, groupModelRevisions, revisionSeriesKey } from './revisions'

function summary(overrides: {
  elements?: number
  spaces?: number
  storeys?: number
  netFloorAreaM2?: number | null
  score?: number
}): BimModelSummary {
  return {
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
    storeys: [],
    spatial: null,
    typeCounts: {},
    propertySetNames: [],
    quantitySetNames: [],
    materialNames: [],
    totals: {
      entities: 0,
      elements: overrides.elements ?? 100,
      spaces: overrides.spaces ?? 10,
      storeys: overrides.storeys ?? 3,
    },
    quantityTotals: {
      netFloorAreaM2: overrides.netFloorAreaM2 === undefined ? 400 : overrides.netFloorAreaM2,
      grossFloorAreaM2: null,
      netVolumeM3: null,
    },
    health:
      overrides.score === undefined
        ? null
        : { score: overrides.score, issues: [], totals: { error: 0, warning: 0, info: 0 } },
    parseMs: 1,
    fileSizeBytes: 1,
    truncatedAt: null,
  }
}

function model(
  filename: string,
  updatedAt: string,
  modelSummary: BimModelSummary | null = summary({})
): BimModelHeaderView {
  return {
    id: `id-${filename}`,
    documentId: `doc-${filename}`,
    displayName: null,
    projectId: 'p1',
    filename,
    status: modelSummary ? 'ready' : 'failed',
    schemaVersion: 'IFC4',
    elementCount: modelSummary?.totals.elements ?? 0,
    errorMessage: null,
    summary: modelSummary,
    updatedAt,
  }
}

describe('revisionSeriesKey', () => {
  it('strips the revision markers an office actually types', () => {
    const expected = 'haus-a'
    for (const name of [
      'Haus-A.ifc',
      'Haus-A_V2.ifc',
      'Haus-A-v10.ifc',
      'Haus-A_rev3.ifc',
      'Haus-A revision 2.ifc',
      'Haus-A_Stand4.ifc',
      'Haus-A (2).ifc',
      'Haus-A_2026-02-11.ifc',
      'Haus-A_20260211.ifc',
    ]) {
      expect(revisionSeriesKey(name)).toBe(expected)
    }
  })

  it('strips a stacked marker', () => {
    expect(revisionSeriesKey('Haus-A_rev3_2026-02-11.ifc')).toBe('haus-a')
  })

  it('does NOT merge a bare trailing number', () => {
    // `Bauteil 2` and `Bauteil 3` are two buildings. Merging them would report
    // one as a 340-element deletion of the other.
    expect(revisionSeriesKey('Bauteil 2.ifc')).not.toBe(revisionSeriesKey('Bauteil 3.ifc'))
  })

  it('keeps a name that is nothing but a marker', () => {
    expect(revisionSeriesKey('v2.ifc')).toBe('v2.ifc')
  })

  it('handles .ifczip and is case-insensitive', () => {
    expect(revisionSeriesKey('HAUS-A_V2.IFCZIP')).toBe('haus-a')
  })
})

describe('groupModelRevisions', () => {
  const MODELS = [
    model('Haus-A_V2.ifc', '2026-02-11T09:00:00.000Z', summary({ elements: 120, spaces: 14, score: 82 })),
    model('Haus-A.ifc', '2026-01-08T09:00:00.000Z', summary({ elements: 100, spaces: 10, score: 74 })),
    model('Halle-B.ifc', '2026-01-20T09:00:00.000Z'),
  ]

  it('orders a series oldest first and marks the latest', () => {
    const [series] = groupModelRevisions(MODELS)
    expect(series.label).toBe('Haus-A')
    expect(series.revisions.map((entry) => entry.model.filename)).toEqual([
      'Haus-A.ifc',
      'Haus-A_V2.ifc',
    ])
    expect(series.revisions[0].isLatest).toBe(false)
    expect(series.revisions[1].isLatest).toBe(true)
    expect(series.revisions[1].index).toBe(2)
  })

  it('puts the most recently touched series first', () => {
    expect(groupModelRevisions(MODELS).map((series) => series.key)).toEqual(['haus-a', 'halle-b'])
  })

  it('computes the step deltas from the stored summaries', () => {
    const [series] = groupModelRevisions(MODELS)
    expect(series.revisions[0].delta).toBeNull()
    expect(series.revisions[1].delta).toEqual({
      previousFilename: 'Haus-A.ifc',
      elements: 20,
      spaces: 4,
      storeys: 0,
      netFloorArea: 0,
      healthScore: 8,
    })
  })

  it('reports no delta rather than zeros when a revision has no summary', () => {
    // A failed extraction has no numbers. Subtracting it from its predecessor
    // would print "−100 elements" for a file we simply could not read.
    const series = groupModelRevisions([
      model('Haus-A.ifc', '2026-01-08T09:00:00.000Z'),
      model('Haus-A_V2.ifc', '2026-02-11T09:00:00.000Z', null),
    ])[0]
    expect(series.revisions[1].delta).toBeNull()
  })

  it('keeps a delta null when only one side publishes the figure', () => {
    const series = groupModelRevisions([
      model('Haus-A.ifc', '2026-01-08T09:00:00.000Z', summary({ netFloorAreaM2: null })),
      model('Haus-A_V2.ifc', '2026-02-11T09:00:00.000Z', summary({ netFloorAreaM2: 410 })),
    ])[0]
    expect(series.revisions[1].delta?.netFloorArea).toBeNull()
    expect(series.revisions[1].delta?.elements).toBe(0)
  })

  it('orders same-timestamp uploads by name so the list does not shuffle', () => {
    const stamp = '2026-01-08T09:00:00.000Z'
    const series = groupModelRevisions([
      model('Haus-A_V3.ifc', stamp),
      model('Haus-A_V2.ifc', stamp),
    ])[0]
    expect(series.revisions.map((entry) => entry.model.filename)).toEqual([
      'Haus-A_V2.ifc',
      'Haus-A_V3.ifc',
    ])
  })
})

describe('findRevisionSeries', () => {
  const SERIES = groupModelRevisions([
    model('Haus-A.ifc', '2026-01-08T09:00:00.000Z'),
    model('Haus-A_V2.ifc', '2026-02-11T09:00:00.000Z'),
    model('Halle-B.ifc', '2026-01-20T09:00:00.000Z'),
  ])

  it('finds the series holding a model, not just the first one', () => {
    expect(findRevisionSeries(SERIES, 'id-Halle-B.ifc')?.key).toBe('halle-b')
  })

  it('returns null for no selection and for an unknown model', () => {
    expect(findRevisionSeries(SERIES, null)).toBeNull()
    expect(findRevisionSeries(SERIES, 'id-nope')).toBeNull()
  })
})
