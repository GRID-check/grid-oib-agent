/**
 * Render tests for the structured (non-schematic) Grid cards: the requirement
 * checklist and the comparison table. Focus: verdicts surface as German
 * labels, per-item references render inline when they differ from the footer,
 * and comparison cells fall back to an em dash instead of an empty cell.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RequirementChecklistCard } from './RequirementChecklistCard'
import { ComparisonTableCard } from './ComparisonTableCard'

describe('RequirementChecklistCard', () => {
  it('renders items with verdicts and surfaces the worst as the card pill', () => {
    render(
      <RequirementChecklistCard
        title="Anforderungen GK 4 – Brandschutz"
        items={[
          {
            label: 'Tragende Bauteile REI 60',
            status: 'pass',
            detail: 'Stahlbetondecken erfüllen REI 90.',
            reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
          },
          { label: 'Zweiter Fluchtweg', status: 'fail' },
          { label: 'Anleiterbarkeit', status: 'needs_input' },
        ]}
        reference={{ document: 'OIB-Richtlinie 2', edition: 'Ausgabe Mai 2023' }}
      />
    )

    expect(screen.getByText('Anforderungen GK 4 – Brandschutz')).toBeInTheDocument()
    expect(screen.getByText('Tragende Bauteile REI 60')).toBeInTheDocument()
    expect(screen.getByText('Stahlbetondecken erfüllen REI 90.')).toBeInTheDocument()
    // Item reference (differs from the footer reference) → inline citation chip.
    expect(screen.getByText('OIB-Richtlinie 2 · Tabelle 1b')).toBeInTheDocument()
    // Non-pass rows show their German verdict inline; pass rows convey the
    // verdict through the check-circle icon's aria-label (colour never alone).
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
    expect(screen.getByText('Angabe fehlt')).toBeInTheDocument()
    expect(screen.getByLabelText('erfüllt')).toBeInTheDocument()
  })
})

describe('ComparisonTableCard', () => {
  it('renders options as columns, criteria as rows, and the recommendation', () => {
    render(
      <ComparisonTableCard
        title="GK 4 vs. GK 5"
        options={['GK 4', 'GK 5']}
        rows={[
          { label: 'Fluchtniveau', values: ['≤ 11 m', '≤ 22 m'], highlight_index: 0 },
          { label: 'Sprinkler', values: ['nein', ''] },
        ]}
        recommendation="GK 4 genügt für dieses Projekt."
        reference={{ document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' }}
      />
    )

    expect(screen.getByRole('columnheader', { name: 'GK 4' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'GK 5' })).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'Fluchtniveau' })).toBeInTheDocument()
    expect(screen.getByText('≤ 11 m')).toBeInTheDocument()
    // An empty value renders an em dash, never a blank cell.
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('GK 4 genügt für dieses Projekt.')).toBeInTheDocument()
    expect(screen.getByText('OIB-Richtlinie 2')).toBeInTheDocument()
  })
})
