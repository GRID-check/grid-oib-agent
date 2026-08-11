/**
 * The model's facts in the file preview's metadata rail.
 *
 * The rail used to describe a 148 MB building with the passage count of the
 * prose written about it. What it must say instead is what the model contains —
 * and, just as importantly, must NOT say anything the export did not publish.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IfcFileFacts } from './ifc-file-facts'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import type { BimModelSummary } from '@/lib/bim/types'

const state: { models: BimModelHeaderView[] | null } = { models: null }

vi.mock('../hooks/use-bim-model', () => ({
  useProjectBimModels: () => ({ data: state.models, isLoading: false, error: null, reload: () => {} }),
}))

/** A summary with only the fields this rail reads; the rest is real shape. */
function summary(overrides: Partial<BimModelSummary> = {}): BimModelSummary {
  return {
    schema: 'IFC4',
    header: {
      name: 'Wohnhaus-Grungasse-14_V3.ifc',
      description: [],
      author: ['A. Muster'],
      organization: [],
      preprocessorVersion: null,
      originatingSystem: 'ArchiCAD 27',
      timeStamp: '2026-05-04T09:00:00',
    },
    units: {
      length: { symbol: 'm', siScale: 1 },
      area: { symbol: 'm²', siScale: 1 },
      volume: null,
    },
    projectName: 'Wohnhaus Grungasse 14',
    siteName: null,
    buildingNames: ['Bauteil A'],
    storeys: [],
    spatial: null,
    typeCounts: {},
    propertySetNames: [],
    quantitySetNames: [],
    materialNames: [],
    totals: { entities: 40_000, elements: 1842, spaces: 41, storeys: 5 },
    quantityTotals: { netFloorAreaM2: 1240.5, grossFloorAreaM2: null, netVolumeM3: null },
    health: null,
    parseMs: 900,
    fileSizeBytes: 148_900_000,
    truncatedAt: null,
    ...overrides,
  }
}

function model(overrides: Partial<BimModelHeaderView> = {}): BimModelHeaderView {
  return {
    id: 'model-1',
    documentId: 'doc-1',
    projectId: 'proj-1',
    filename: 'Haus-A.ifc',
    status: 'ready',
    schemaVersion: 'IFC4',
    elementCount: 1842,
    errorMessage: null,
    summary: summary(),
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  }
}

function renderFacts(): void {
  render(<IfcFileFacts documentId="doc-1" projectId="proj-1" />)
}

beforeEach(() => {
  state.models = null
})

describe('IfcFileFacts', () => {
  it('states what the model contains', () => {
    state.models = [model()]
    renderFacts()

    expect(screen.getByText('Storeys')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    // Grouped like the area beneath it, and by the INTERFACE locale — an
    // English rail must not print the Austrian `1.842`, which reads as 1.842.
    expect(screen.getByText('1,842')).toBeInTheDocument()
    expect(screen.getByText('41')).toBeInTheDocument()
    expect(screen.getByText('IFC4')).toBeInTheDocument()
  })

  it('prints a published area with the unit the FILE declares', () => {
    state.models = [model()]
    renderFacts()

    expect(screen.getByText('1,240.5 m²')).toBeInTheDocument()
  })

  it('omits an area the export never published rather than calling it zero', () => {
    state.models = [
      model({
        summary: summary({
          quantityTotals: { netFloorAreaM2: null, grossFloorAreaM2: null, netVolumeM3: null },
        }),
      }),
    ]
    renderFacts()

    // The row is gone; nothing anywhere claims this building has no floor area.
    expect(screen.queryByText('Net floor area')).not.toBeInTheDocument()
    expect(screen.queryByText(/0 m²/)).not.toBeInTheDocument()
    // The rest of the model is still stated.
    expect(screen.getByText('Storeys')).toBeInTheDocument()
  })

  it('renders nothing while the model is still being read', () => {
    state.models = [model({ status: 'extracting', summary: null })]
    const { container } = render(<IfcFileFacts documentId="doc-1" projectId="proj-1" />)

    // The viewport in the same pane already says so; a second empty panel
    // repeating it is noise.
    expect(container).toBeEmptyDOMElement()
  })

  it('never shows another document’s model', () => {
    state.models = [model({ documentId: 'doc-2' })]
    const { container } = render(<IfcFileFacts documentId="doc-1" projectId="proj-1" />)

    expect(container).toBeEmptyDOMElement()
  })
})
