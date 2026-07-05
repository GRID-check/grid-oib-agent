/**
 * Render tests for the five schematic Grid cards: realistic OIB parameter
 * sets in, deterministic SVG + verdict chrome out. Focus: to-scale rendering
 * never throws, statuses surface as German verdicts, unknown values read
 * "fehlende Angabe" instead of a guessed number, and the NormReference
 * footer grounds every drawn limit.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BuildingSectionCard } from './BuildingSectionCard'
import { StairDiagramCard } from './StairDiagramCard'
import { DimensionDiagramCard } from './DimensionDiagramCard'
import { SetbackPlanCard } from './SetbackPlanCard'
import { EgressDiagramCard } from './EgressDiagramCard'

describe('BuildingSectionCard', () => {
  it('draws storeys, ground datum, and threshold markers with the norm footer', () => {
    render(
      <BuildingSectionCard
        title="Gebäudeschnitt – Höhenprüfung GK4"
        storeys={[
          { label: 'KG', height_m: 2.5, below_grade: true },
          { label: 'EG', height_m: 3.2 },
          { label: '1.OG', height_m: 3.0 },
          { label: '2.OG', height_m: 3.0 },
          { label: '3.OG', height_m: 3.0 },
        ]}
        markers={[
          { label: 'Fluchtniveau', height_m: 9.2, kind: 'fluchtniveau' },
          { label: 'GK4-Grenze', height_m: 11, kind: 'threshold' },
        ]}
        reference={{
          document: 'OIB-Richtlinie 2',
          section: 'Pkt. 2.1',
          edition: 'Ausgabe Mai 2023',
        }}
      />
    )

    expect(screen.getByText('Gebäudeschnitt – Höhenprüfung GK4')).toBeInTheDocument()
    expect(screen.getByText('±0,00')).toBeInTheDocument()
    expect(screen.getByText('Fluchtniveau')).toBeInTheDocument()
    expect(screen.getByText('GK4-Grenze')).toBeInTheDocument()
    expect(screen.getByText('+11 m')).toBeInTheDocument()
    expect(screen.getByText('OIB-Richtlinie 2')).toBeInTheDocument()
    expect(screen.getByText('Pkt. 2.1')).toBeInTheDocument()
  })
})

describe('StairDiagramCard', () => {
  it('renders the step notation, all three checks, and the comfort note', () => {
    render(
      <StairDiagramCard
        title="Treppenlauf – Steigungsverhältnis"
        riser_count={17}
        riser_height={{
          label: 'Steigung',
          value: 17.6,
          required: 18,
          unit: 'cm',
          comparator: '<=',
          status: 'pass',
        }}
        tread_depth={{
          label: 'Auftritt',
          value: 28,
          required: 28,
          unit: 'cm',
          comparator: '>=',
          status: 'pass',
        }}
        width={{
          label: 'Nutzbare Laufbreite',
          value: 120,
          required: 120,
          unit: 'cm',
          comparator: '>=',
          status: 'pass',
        }}
        comfort_note="Schrittmaß 2×17,6 + 28 = 63,2 cm — innerhalb der Komfortregel (59–65 cm)."
        reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 2.2', edition: 'Ausgabe Mai 2023' }}
      />
    )

    expect(screen.getByText('17 Stg · 17,6/28 cm')).toBeInTheDocument()
    expect(screen.getByText('Steigung')).toBeInTheDocument()
    expect(screen.getByText('Nutzbare Laufbreite')).toBeInTheDocument()
    expect(screen.getByText(/Schrittmaß 2×17,6/)).toBeInTheDocument()
    expect(screen.getByText('erfüllt')).toBeInTheDocument()
  })
})

describe('DimensionDiagramCard', () => {
  it('shows an unknown door width as "fehlende Angabe", never a number', () => {
    render(
      <DimensionDiagramCard
        title="Türe – lichte Durchgangsbreite"
        shape="door"
        dimensions={[
          {
            label: 'lichte Durchgangsbreite',
            value: null,
            required: 80,
            unit: 'cm',
            comparator: '>=',
            status: 'needs_input',
          },
          {
            label: 'Durchgangshöhe',
            value: 210,
            required: 200,
            unit: 'cm',
            comparator: '>=',
            status: 'pass',
          },
        ]}
        reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 2.1.3' }}
      />
    )

    expect(screen.getAllByText('fehlende Angabe').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Angabe fehlt')).toBeInTheDocument()
    expect(screen.getAllByText('210 cm').length).toBeGreaterThanOrEqual(1)
  })

  it('renders the ramp template with the slope annotated on the incline', () => {
    render(
      <DimensionDiagramCard
        title="Rampe – Neigung & Breite"
        shape="ramp"
        dimensions={[
          { label: 'Neigung', value: 6, required: 6, unit: '%', comparator: '<=', status: 'pass' },
          { label: 'Länge', value: 6, unit: 'm', status: 'pass' },
          { label: 'nutzbare Breite', value: 120, required: 120, unit: 'cm', comparator: '>=', status: 'pass' },
        ]}
        reference={{ document: 'ÖNORM B 1600', section: 'Pkt. 4.3' }}
      />
    )

    expect(screen.getAllByText('6 %').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('nutzbare Breite')).toBeInTheDocument()
    expect(screen.getByText('ÖNORM B 1600')).toBeInTheDocument()
  })
})

describe('SetbackPlanCard', () => {
  it('marks a failing side red and lists every side check', () => {
    render(
      <SetbackPlanCard
        title="Abstandsflächen – Lageplan"
        parcel_width_m={20}
        parcel_depth_m={32}
        building_width_m={12}
        building_depth_m={10}
        sides={[
          { side: 'front', required_m: 5, actual_m: 6, status: 'pass' },
          { side: 'back', required_m: 3, actual_m: 16, status: 'pass' },
          { side: 'left', required_m: 3, actual_m: 2, status: 'fail' },
          { side: 'right', required_m: 3, actual_m: 6, status: 'pass' },
        ]}
        reference={{ document: 'NÖ Bauordnung 2014', section: '§ 50' }}
      />
    )

    expect(screen.getByText('Grundstück 20 × 32 m')).toBeInTheDocument()
    expect(screen.getByText('Abstand links')).toBeInTheDocument()
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
    expect(
      screen.getByText('Mindestens ein Abstand unterschreitet das geforderte Maß.')
    ).toBeInTheDocument()
  })
})

describe('EgressDiagramCard', () => {
  it('draws the segment run, sums the total, and reads it against the limit', () => {
    render(
      <EgressDiagramCard
        title="Fluchtweg – Gehweglänge"
        segments={[
          { label: 'Raum → Gang', length_m: 12, turn: 'right' },
          { label: 'Gang → Treppenhaus', length_m: 26, turn: 'straight' },
        ]}
        total_length={{
          label: 'Gehweglänge gesamt',
          value: 38,
          required: 40,
          unit: 'm',
          comparator: '<=',
          status: 'pass',
        }}
        start_label="ungünstigster Punkt"
        exit_label="Treppenhaus"
        reference={{ document: 'OIB-Richtlinie 2', section: 'Pkt. 5.1.1' }}
      />
    )

    expect(screen.getByText('Raum → Gang')).toBeInTheDocument()
    expect(screen.getByText('ungünstigster Punkt')).toBeInTheDocument()
    expect(screen.getByText('Treppenhaus')).toBeInTheDocument()
    expect(screen.getByText(/^38 m/)).toBeInTheDocument()
    expect(screen.getByText(/≤ 40 m/)).toBeInTheDocument()
  })
})
