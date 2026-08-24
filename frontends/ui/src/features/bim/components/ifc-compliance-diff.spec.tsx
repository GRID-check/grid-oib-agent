/**
 * The requirement-status diff between two revisions.
 *
 * The assertions are about the two ways this screen could mislead: burying a
 * regression among improvements, and reporting "nothing changed" in a way that
 * reads as "nothing ran".
 *
 * Rendered in English — the default test locale.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IfcComplianceDiff } from './ifc-compliance-diff'
import type { BimComplianceChange } from '@/lib/bim/rules'
import type { BimModelHeaderView } from '../hooks/use-bim-model'

const BASE: BimModelHeaderView = {
  id: 'model-v2',
  documentId: 'doc-v2',
  projectId: 'p1',
  filename: 'haus-a_V2.ifc',
  displayName: null,
  status: 'ready',
  schemaVersion: 'IFC4',
  elementCount: 120,
  errorMessage: null,
  summary: null,
  updatedAt: '2026-02-11T09:00:00.000Z',
}

const CHANGES: BimComplianceChange[] = [
  {
    ruleId: 'oib4-treppe-steigungsverhaeltnis',
    titleDe: 'Treppen — Steigungsverhältnis',
    richtlinie: 'OIB 4',
    trend: 'broken',
    before: { passed: 3, failed: 0, undecidable: 0 },
    after: { passed: 2, failed: 1, undecidable: 0 },
  },
  {
    ruleId: 'oib2-feuerwiderstand-tragend',
    titleDe: 'Tragende Bauteile — Feuerwiderstand',
    richtlinie: 'OIB 2',
    trend: 'undecidable',
    before: { passed: 34, failed: 0, undecidable: 0 },
    after: { passed: 0, failed: 0, undecidable: 34 },
  },
  {
    ruleId: 'oib4-tuer-durchgangsbreite',
    titleDe: 'Türen — lichte Durchgangsbreite',
    richtlinie: 'OIB 4',
    trend: 'resolved',
    before: { passed: 22, failed: 2, undecidable: 0 },
    after: { passed: 24, failed: 0, undecidable: 0 },
  },
]

function diff(overrides: Partial<React.ComponentProps<typeof IfcComplianceDiff>> = {}) {
  return render(
    <IfcComplianceDiff
      baseModel={BASE}
      changes={CHANGES}
      isLoading={false}
      error={null}
      onRun={() => {}}
      {...overrides}
    />
  )
}

describe('IfcComplianceDiff', () => {
  it('renders nothing when there is no previous revision to compare against', () => {
    const { container } = diff({ baseModel: null })
    expect(container).toBeEmptyDOMElement()
  })

  it('names the revision it is comparing against', () => {
    diff()
    expect(screen.getByText(/against haus-a_V2\.ifc/)).toBeInTheDocument()
  })

  it('runs only when asked, because it reads both element sets', async () => {
    const onRun = vi.fn()
    diff({ changes: null, onRun })
    await userEvent.click(screen.getByRole('button', { name: 'Compare requirement status' }))
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('leads with what the revision broke', () => {
    diff()
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Treppen — Steigungsverhältnis')
    expect(rows[0]).toHaveTextContent('newly not met')
  })

  it('calls out a requirement that stopped being checkable', () => {
    // A re-export that drops a property silently un-checks a requirement that
    // was green yesterday. A pass/fail comparison would never mention it.
    diff()
    expect(screen.getByText('no longer decidable (the value is gone from the model)')).toBeInTheDocument()
  })

  it('shows both sides so a trend is evidence rather than a claim', () => {
    diff()
    expect(screen.getByText(/3\/0\/0 → 2\/1\/0/)).toBeInTheDocument()
  })

  it('reports "nothing moved" as a result, not as an empty screen', () => {
    diff({ changes: [] })
    expect(
      screen.getByText('No requirement changed its status between these two revisions.')
    ).toBeInTheDocument()
  })

  it('reports a failed run instead of implying nothing changed', () => {
    diff({ changes: null, error: 'load-failed' })
    expect(screen.getByText('The requirement-status comparison could not be run.')).toBeInTheDocument()
    expect(screen.queryByText(/No requirement changed/)).not.toBeInTheDocument()
  })
})
