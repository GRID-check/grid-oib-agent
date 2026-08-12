/**
 * The model explorer — the half of the model page that needs no GPU.
 *
 * These are the assertions that matter for a user who cannot run the viewport
 * at all: the numbers are right and carry their units, the storey filter
 * actually narrows the element list, and an element's properties render as
 * something readable rather than as raw JSON.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  IfcElementTable,
  IfcModelHealthPanel,
  IfcModelOverview,
  IfcPropertyPanel,
  IfcSpatialTree,
} from './ifc-model-explorer'
import { IfcModelCompare } from './ifc-model-compare'
import type { BimModelSummary } from '@/lib/bim/types'
import type { BimViewerElement } from '../lib/model-index'
import type { BimElementDetail } from '../hooks/use-bim-model'

const SUMMARY: BimModelSummary = {
  schema: 'IFC4',
  header: {
    name: 'haus-a.ifc',
    timeStamp: '2026-02-03T10:00:00',
    author: ['A. Muster'],
    organization: ['Musterbuero ZT GmbH'],
    preprocessorVersion: 'GRID',
    originatingSystem: 'Revit 2026',
    description: [],
  },
  units: {
    length: { symbol: 'mm', siScale: 0.001 },
    area: { symbol: 'm²', siScale: 1 },
    volume: { symbol: 'm³', siScale: 1 },
  },
  projectName: 'Wohnhaus Beispielgasse',
  siteName: 'Grundstueck 12',
  buildingNames: ['Haus A'],
  storeys: [
    { globalId: 'g-eg', expressId: 16, name: 'Erdgeschoss', elevation: 0, elementCount: 3 },
    { globalId: 'g-og', expressId: 17, name: 'Obergeschoss', elevation: 3, elementCount: 1 },
  ],
  spatial: {
    globalId: 'g-project',
    expressId: 13,
    ifcType: 'IfcProject',
    name: 'Wohnhaus Beispielgasse',
    elevation: null,
    elementCount: 0,
    children: [
      {
        globalId: 'g-eg',
        expressId: 16,
        ifcType: 'IfcBuildingStorey',
        name: 'Erdgeschoss',
        elevation: 0,
        elementCount: 3,
        children: [],
      },
      {
        globalId: 'g-og',
        expressId: 17,
        ifcType: 'IfcBuildingStorey',
        name: 'Obergeschoss',
        elevation: 3,
        elementCount: 1,
        children: [],
      },
    ],
  },
  typeCounts: { IfcWall: 3, IfcSpace: 1 },
  propertySetNames: ['Pset_WallCommon'],
  quantitySetNames: ['Qto_WallBaseQuantities'],
  materialNames: ['Stahlbeton'],
  totals: { entities: 116, elements: 4, spaces: 1, storeys: 2 },
  quantityTotals: { netFloorAreaM2: 69, grossFloorAreaM2: 74.2, netVolumeM3: 80 },
  health: { score: 100, totals: { error: 0, warning: 0, info: 0 }, issues: [] },
  parseMs: 21,
  fileSizeBytes: 8439,
  truncatedAt: null,
}

const ELEMENTS: BimViewerElement[] = [
  { globalId: 'g-w1', expressId: 21, ifcType: 'IfcWall', name: 'Aussenwand Nord', storeyName: 'Erdgeschoss' },
  { globalId: 'g-w2', expressId: 22, ifcType: 'IfcWall', name: 'Innenwand EG', storeyName: 'Erdgeschoss' },
  { globalId: 'g-w3', expressId: 24, ifcType: 'IfcWall', name: 'Aussenwand OG', storeyName: 'Obergeschoss' },
  { globalId: 'g-s1', expressId: 36, ifcType: 'IfcSpace', name: 'Wohnzimmer', storeyName: 'Erdgeschoss' },
]

describe('IfcModelOverview', () => {
  it('states the building totals with the model’s own units', () => {
    render(<IfcModelOverview summary={SUMMARY} filename="haus-a.ifc" />)
    expect(screen.getByText('69 m²')).toBeInTheDocument()
    expect(screen.getByText('74.2 m²')).toBeInTheDocument()
    expect(screen.getByText('80 m³')).toBeInTheDocument()
  })

  it('shows the model’s provenance, so an answer can be traced to an export', () => {
    render(<IfcModelOverview summary={SUMMARY} filename="haus-a.ifc" />)
    expect(screen.getByText('Revit 2026')).toBeInTheDocument()
    expect(screen.getByText('A. Muster')).toBeInTheDocument()
    expect(screen.getByText('IFC4')).toBeInTheDocument()
  })

  it('distinguishes an absent quantity from a zero one', () => {
    // A model that publishes no volume must not read as a building of 0 m³.
    const withoutVolume = {
      ...SUMMARY,
      quantityTotals: { ...SUMMARY.quantityTotals, netVolumeM3: null },
    }
    render(<IfcModelOverview summary={withoutVolume} filename="haus-a.ifc" />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('0 m³')).not.toBeInTheDocument()
  })

  it('says out loud when the element list was capped', () => {
    render(<IfcModelOverview summary={{ ...SUMMARY, truncatedAt: 200000 }} filename="haus-a.ifc" />)
    expect(screen.getByText(/more than 200000 elements/)).toBeInTheDocument()
  })
})

describe('IfcSpatialTree', () => {
  it('lists the storeys with their elevations and counts', () => {
    render(<IfcSpatialTree summary={SUMMARY} selectedStorey={null} onSelectStorey={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Erdgeschoss/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Obergeschoss.*\+3 m/ })).toBeInTheDocument()
  })

  it('selects a storey and can clear the selection', async () => {
    const onSelectStorey = vi.fn()
    render(<IfcSpatialTree summary={SUMMARY} selectedStorey="Erdgeschoss" onSelectStorey={onSelectStorey} />)

    await userEvent.click(screen.getByRole('button', { name: /Obergeschoss/ }))
    expect(onSelectStorey).toHaveBeenCalledWith('Obergeschoss')

    await userEvent.click(screen.getByRole('button', { name: 'All storeys' }))
    expect(onSelectStorey).toHaveBeenCalledWith(null)
  })

  it('marks the active storey pressed, not merely styled', () => {
    render(<IfcSpatialTree summary={SUMMARY} selectedStorey="Erdgeschoss" onSelectStorey={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Erdgeschoss/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('does not offer a non-storey node as a filter', () => {
    render(<IfcSpatialTree summary={SUMMARY} selectedStorey={null} onSelectStorey={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Wohnhaus Beispielgasse/ })).toBeDisabled()
  })
})

describe('IfcElementTable', () => {
  it('lists every element when nothing is filtered', () => {
    render(
      <IfcElementTable
        elements={ELEMENTS}
        storeyFilter={null}
        selectedGlobalId={null}
        onSelect={vi.fn()}
      />
    )
    // `total` is the FILTERED row count, so "of 4 elements" claimed the
    // building has four; with a type selected it read "300 of 812 elements"
    // about 812 walls.
    expect(screen.getByText('4 of 4 matches')).toBeInTheDocument()
  })

  it('narrows to the storey the tree selected', () => {
    render(
      <IfcElementTable
        elements={ELEMENTS}
        storeyFilter="Obergeschoss"
        selectedGlobalId={null}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText('1 of 1 matches')).toBeInTheDocument()
    expect(screen.getByText('Aussenwand OG')).toBeInTheDocument()
    expect(screen.queryByText('Innenwand EG')).not.toBeInTheDocument()
  })

  it('searches by name', async () => {
    render(
      <IfcElementTable elements={ELEMENTS} storeyFilter={null} selectedGlobalId={null} onSelect={vi.fn()} />
    )
    await userEvent.type(screen.getByLabelText('Search by name, tag or GlobalId…'), 'innen')
    expect(screen.getByText('Innenwand EG')).toBeInTheDocument()
    expect(screen.queryByText('Aussenwand Nord')).not.toBeInTheDocument()
  })

  it('filters by IFC type', async () => {
    render(
      <IfcElementTable elements={ELEMENTS} storeyFilter={null} selectedGlobalId={null} onSelect={vi.fn()} />
    )
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'IfcSpace')
    expect(screen.getByText('Wohnzimmer')).toBeInTheDocument()
    expect(screen.queryByText('Aussenwand Nord')).not.toBeInTheDocument()
  })

  it('reports an empty result rather than showing an empty table', async () => {
    render(
      <IfcElementTable elements={ELEMENTS} storeyFilter={null} selectedGlobalId={null} onSelect={vi.fn()} />
    )
    await userEvent.type(screen.getByLabelText('Search by name, tag or GlobalId…'), 'zzz')
    expect(screen.getByText('No element matches this filter.')).toBeInTheDocument()
  })

  it('selects a row, which is what drives the viewport highlight', async () => {
    const onSelect = vi.fn()
    render(
      <IfcElementTable elements={ELEMENTS} storeyFilter={null} selectedGlobalId={null} onSelect={onSelect} />
    )
    await userEvent.click(screen.getByText('Aussenwand Nord'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ globalId: 'g-w1' }))
  })
})

describe('IfcPropertyPanel', () => {
  const DETAIL: BimElementDetail = {
    globalId: 'g-w1',
    expressId: 21,
    ifcType: 'IfcWall',
    name: 'Aussenwand Nord',
    description: null,
    predefinedType: 'SOLIDWALL',
    objectType: null,
    tag: 'W-01',
    typeName: 'AW 38 Stahlbeton',
    storeyName: 'Erdgeschoss',
    materials: ['Stahlbeton', 'Waermedaemmung EPS'],
    classifications: [{ system: 'ON B 1800', identification: 'B.1.2', name: 'Aussenwand' }],
    properties: { Pset_WallCommon: { IsExternal: true, FireRating: 'REI 90', ThermalTransmittance: 0.18 } },
    quantities: { Qto_WallBaseQuantities: { NetSideArea: 24.5 } },
  }

  it('prompts for a selection when there is none', () => {
    render(<IfcPropertyPanel element={null} isLoading={false} error={null} />)
    expect(screen.getByText('Select an element to see its properties.')).toBeInTheDocument()
  })

  it('renders identity, materials, classification, properties and quantities', () => {
    render(<IfcPropertyPanel element={DETAIL} isLoading={false} error={null} />)
    expect(screen.getByText('g-w1')).toBeInTheDocument()
    expect(screen.getByText('AW 38 Stahlbeton')).toBeInTheDocument()
    expect(screen.getByText('Waermedaemmung EPS')).toBeInTheDocument()
    expect(screen.getByText('B.1.2')).toBeInTheDocument()
    expect(screen.getByText('REI 90')).toBeInTheDocument()
    expect(screen.getByText('24.5')).toBeInTheDocument()
  })

  it('renders booleans as words, because "true" is not an answer in German', () => {
    render(<IfcPropertyPanel element={DETAIL} isLoading={false} error={null} />)
    const pset = screen.getByText('IsExternal').closest('div')
    expect(within(pset as HTMLElement).getByText('Ja')).toBeInTheDocument()
  })

  it('reports a load failure instead of an empty panel', () => {
    render(<IfcPropertyPanel element={null} isLoading={false} error="load-failed" />)
    expect(screen.getByText('The element could not be loaded.')).toBeInTheDocument()
  })
})

describe('IfcModelHealthPanel', () => {
  const HEALTH = {
    score: 74,
    totals: { error: 1, warning: 1, info: 1 },
    issues: [
      {
        rule: 'complete-no-classifications' as const,
        stage: 'complete' as const,
        severity: 'info' as const,
        count: 175,
        total: 175,
        sampleGlobalIds: [],
        detail: null,
      },
      {
        rule: 'properties-missing-common-pset' as const,
        stage: 'properties' as const,
        severity: 'warning' as const,
        count: 11,
        total: 64,
        sampleGlobalIds: ['g-w3'],
        detail: 'IfcWall · Pset_WallCommon',
      },
      {
        rule: 'spatial-orphan-elements' as const,
        stage: 'spatial' as const,
        severity: 'error' as const,
        count: 6,
        total: 175,
        sampleGlobalIds: ['g-w4'],
        detail: null,
      },
    ],
  }

  it('leads with the error, whatever order the rules ran in', () => {
    render(<IfcModelHealthPanel health={HEALTH} />)
    const items = screen.getAllByRole('listitem')
    // The validator emits stage by stage; a reader wants severity first.
    expect(items[0]).toHaveTextContent('Elements in no storey')
  })

  it('states the share affected, not a bare count', () => {
    render(<IfcModelHealthPanel health={HEALTH} />)
    // "11 walls are missing a property set" and "11 of 64" are different facts.
    expect(screen.getByText(/IfcWall · Pset_WallCommon · 11 of 64/)).toBeInTheDocument()
  })

  it('hides notes in the compact variant but never the error', () => {
    render(<IfcModelHealthPanel health={HEALTH} compact />)
    expect(screen.getByText('Elements in no storey — missing from every per-storey figure')).toBeInTheDocument()
    expect(screen.queryByText('No element carries a classification')).not.toBeInTheDocument()
  })

  it('offers to show the affected elements when it has ids for them', async () => {
    const onShowElements = vi.fn()
    render(<IfcModelHealthPanel health={HEALTH} onShowElements={onShowElements} />)
    await userEvent.click(screen.getAllByRole('button', { name: 'Show elements' })[0])
    expect(onShowElements).toHaveBeenCalledWith(['g-w4'])
  })

  it('says so plainly when a model has no findings', () => {
    render(<IfcModelHealthPanel health={{ score: 100, totals: { error: 0, warning: 0, info: 0 }, issues: [] }} />)
    expect(screen.getByText(/No findings/)).toBeInTheDocument()
  })
})

describe('IfcModelCompare', () => {
  const CANDIDATES = [
    {
      id: 'model-v1',
      documentId: 'doc-v1',
      projectId: 'p1',
      filename: 'haus-a-v1.ifc',
      status: 'ready' as const,
      schemaVersion: 'IFC4',
      elementCount: 40,
      errorMessage: null,
      summary: null,
      updatedAt: '2026-01-08T09:00:00.000Z',
    },
  ]

  it('says what to do when there is nothing to compare against', () => {
    render(<IfcModelCompare modelId="model-v2" candidates={[]} />)
    expect(screen.getByText('Upload a second revision to compare.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Compare' })).not.toBeInTheDocument()
  })

  it('runs the comparison and shows each bucket', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        comparison: {
          added: [{ globalId: 'g-d9', ifcType: 'IfcDoor', name: 'Fluchttuer', storeyName: 'OG' }],
          removed: [],
          changed: [
            {
              globalId: 'g-w1',
              ifcType: 'IfcWall',
              name: 'Aussenwand Nord',
              storeyName: 'EG',
              changes: [
                { field: 'Pset_WallCommon.FireRating', before: 'REI 90', after: 'REI 30', delta: null },
              ],
            },
          ],
          unchangedCount: 38,
          // The badges read these, NOT the list lengths — the lists are capped
          // at 500 rows, so a revision that added three thousand elements used
          // to render "Neu 500".
          counts: { added: 1, removed: 1, changed: 1 },
          totals: { base: 40, revision: 40 },
          truncated: false,
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<IfcModelCompare modelId="model-v2" candidates={CANDIDATES} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare' }))

    expect(await screen.findByText('Added 1')).toBeInTheDocument()
    expect(screen.getByText('Unchanged 38')).toBeInTheDocument()
    // The changed field is shown with both sides — "something changed" is not
    // an answer an architect can act on.
    expect(screen.getByText('Pset_WallCommon.FireRating')).toBeInTheDocument()
    expect(screen.getByText('REI 30')).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('warns instead of reassuring when a side was capped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          comparison: {
            added: [],
            removed: [],
            changed: [],
            unchangedCount: 20_000,
            counts: { added: 0, removed: 0, changed: 0 },
            totals: { base: 20_000, revision: 20_000 },
            truncated: true,
          },
        }),
      }))
    )

    render(<IfcModelCompare modelId="model-v2" candidates={CANDIDATES} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare' }))

    // "No differences" over a partial index is the most dangerous sentence this
    // panel can produce, so the caveat sits next to it.
    expect(await screen.findByText(/comparison may be incomplete/)).toBeInTheDocument()
    expect(screen.getByText('No differences between these two revisions.')).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('reports a failed comparison rather than an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    render(<IfcModelCompare modelId="model-v2" candidates={CANDIDATES} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(await screen.findByText('The comparison could not be run.')).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
