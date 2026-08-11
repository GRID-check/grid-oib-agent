/**
 * The revision timeline.
 *
 * The assertions are about the two ways a timeline lies: printing a zero delta
 * for a revision that has no comparable figures, and offering a comparison
 * against a revision that is not actually the predecessor.
 *
 * Rendered in English — the default test locale.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IfcRevisionTimeline } from './ifc-revision-timeline'
import { groupModelRevisions } from '../lib/revisions'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import type { BimModelSummary } from '@/lib/bim/types'

function summary(elements: number, spaces: number, score: number): BimModelSummary {
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
    totals: { entities: 0, elements, spaces, storeys: 4 },
    quantityTotals: { netFloorAreaM2: 400, grossFloorAreaM2: null, netVolumeM3: null },
    health: { score, issues: [], totals: { error: 0, warning: 0, info: 0 } },
    parseMs: 1,
    fileSizeBytes: 1,
    truncatedAt: null,
  }
}

function model(
  filename: string,
  updatedAt: string,
  modelSummary: BimModelSummary | null
): BimModelHeaderView {
  return {
    id: `id-${filename}`,
    documentId: `doc-${filename}`,
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

const MODELS = [
  model('Haus-A.ifc', '2026-01-08T09:00:00.000Z', summary(100, 10, 74)),
  model('Haus-A_V2.ifc', '2026-02-11T09:00:00.000Z', summary(120, 8, 82)),
  model('Haus-A_V3.ifc', '2026-03-02T09:00:00.000Z', summary(121, 8, 82)),
]

const SERIES = groupModelRevisions(MODELS)[0]

describe('IfcRevisionTimeline', () => {
  const noop = (): void => {}

  it('renders nothing for a single revision — one dot is not a timeline', () => {
    const single = groupModelRevisions([MODELS[0]])[0]
    const { container } = render(
      <IfcRevisionTimeline
        series={single}
        currentModelId={MODELS[0].id}
        onOpen={noop}
        onCompareWithPrevious={noop}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists newest first and marks the current revision', () => {
    render(
      <IfcRevisionTimeline
        series={SERIES}
        currentModelId="id-Haus-A_V2.ifc"
        onOpen={noop}
        onCompareWithPrevious={noop}
      />
    )
    const entries = screen
      .getAllByRole('button')
      .filter((button) => /^Upload \d/.test(button.textContent ?? ''))
      .map((button) => button.textContent)
    expect(entries).toEqual([
      'Upload 3 · Haus-A_V3.ifc',
      'Upload 2 · Haus-A_V2.ifc',
      'Upload 1 · Haus-A.ifc',
    ])
    expect(screen.getByRole('button', { name: 'Upload 2 · Haus-A_V2.ifc' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(screen.getByText('Current')).toBeInTheDocument()
  })

  it('shows each step signed, including a drop', () => {
    render(
      <IfcRevisionTimeline
        series={SERIES}
        currentModelId="id-Haus-A_V3.ifc"
        onOpen={noop}
        onCompareWithPrevious={noop}
      />
    )
    expect(screen.getByText('+20')).toBeInTheDocument()
    // Two rooms disappeared between v1 and v2 — the sign is the whole point.
    expect(screen.getByText('-2')).toBeInTheDocument()
    // Measured and unchanged is not the same as unknown.
    expect(screen.getAllByText('±0').length).toBeGreaterThan(0)
  })

  it('says a revision has no comparable figures instead of printing zeros', () => {
    const withFailure = groupModelRevisions([
      MODELS[0],
      model('Haus-A_V2.ifc', '2026-02-11T09:00:00.000Z', null),
    ])[0]
    render(
      <IfcRevisionTimeline
        series={withFailure}
        currentModelId={MODELS[0].id}
        onOpen={noop}
        onCompareWithPrevious={noop}
      />
    )
    expect(screen.getByText('No comparable figures for this revision.')).toBeInTheDocument()
    expect(screen.queryByText('±0')).not.toBeInTheDocument()
  })

  it('compares a step against its own predecessor, not against the newest', async () => {
    const onCompareWithPrevious = vi.fn()
    render(
      <IfcRevisionTimeline
        series={SERIES}
        currentModelId="id-Haus-A_V3.ifc"
        onOpen={noop}
        onCompareWithPrevious={onCompareWithPrevious}
      />
    )
    // The v2 row must diff against v1, even though v3 is the one on screen.
    await userEvent.click(screen.getByRole('button', { name: 'Compare with Haus-A.ifc' }))
    expect(onCompareWithPrevious).toHaveBeenCalledTimes(1)
    const [revision, previous] = onCompareWithPrevious.mock.calls[0]
    expect(revision.model.filename).toBe('Haus-A_V2.ifc')
    expect(previous.filename).toBe('Haus-A.ifc')
  })

  it('opens the revision that was clicked', async () => {
    const onOpen = vi.fn()
    render(
      <IfcRevisionTimeline
        series={SERIES}
        currentModelId="id-Haus-A_V3.ifc"
        onOpen={onOpen}
        onCompareWithPrevious={noop}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /Upload 1 · Haus-A\.ifc/ }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ filename: 'Haus-A.ifc' }))
  })
})
