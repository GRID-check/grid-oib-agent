/**
 * Render tests for the schematic Grid cards: realistic OIB parameter
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
import { DaylightIncidenceCard } from './DaylightIncidenceCard'
import { GuardrailCheckCard } from './GuardrailCheckCard'
import { DensityCheckCard } from './DensityCheckCard'
import { FireAccessPlanCard } from './FireAccessPlanCard'
import { AcousticCheckCard } from './AcousticCheckCard'
import { FireCompartmentCard } from './FireCompartmentCard'
import { ThermalEnvelopeCard } from './ThermalEnvelopeCard'
import { EnergyPerformanceCard } from './EnergyPerformanceCard'
import { ElevatorRequirementCard } from './ElevatorRequirementCard'
import { ParkingRequirementCard } from './ParkingRequirementCard'

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

describe('DaylightIncidenceCard', () => {
  it('draws the 45° line, derives the 10% glass requirement, and passes a low obstruction', () => {
    render(
      <DaylightIncidenceCard
        title="Belichtung – freier Lichteinfall"
        room_floor_area_m2={20}
        glass_area={{
          label: 'Lichteintrittsfläche',
          value: 2.4,
          required: null,
          unit: 'm²',
          comparator: '>=',
          status: 'pass',
        }}
        window_sill_height_m={0.9}
        window_head_height_m={2.3}
        obstruction={{ distance_m: 8, height_m: 6, label: 'Gegenüberliegendes Gebäude' }}
        reference={{ document: 'OIB-Richtlinie 3', section: 'Pkt. 9.1', edition: 'Ausgabe Mai 2023' }}
      />
    )

    expect(screen.getByText('45°')).toBeInTheDocument()
    expect(screen.getByText('Gegenüberliegendes Gebäude')).toBeInTheDocument()
    // Renderer-derived: 10 % of 20 m² floor area → ≥ 2 m² glass.
    expect(screen.getByText(/Bodenfläche 20 m²/)).toBeInTheDocument()
    expect(screen.getAllByText(/≥ 2 m²/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('erfüllt')).toBeInTheDocument()
    expect(screen.getByText('OIB-Richtlinie 3')).toBeInTheDocument()
  })

  it('fails when the obstruction pierces the 45° cone and flags a missing sill', () => {
    render(
      <DaylightIncidenceCard
        title="Belichtung – Verschattung"
        glass_area={{
          label: 'Lichteintrittsfläche',
          value: null,
          required: null,
          status: 'needs_input',
        }}
        window_sill_height_m={null}
        window_head_height_m={2.4}
        obstruction={{ distance_m: 6, height_m: 10, label: 'Nachbargebäude' }}
        reference={{ document: 'OIB-Richtlinie 3', section: 'Pkt. 9.1' }}
      />
    )

    // Renderer trig: 10 m above the sill at 6 m distance pierces the cone.
    expect(
      screen.getByText('Die Verschattung durchdringt den 45°-Lichteinfallskegel.')
    ).toBeInTheDocument()
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
    expect(screen.getAllByText('fehlende Angabe').length).toBeGreaterThanOrEqual(2)
  })
})

describe('GuardrailCheckCard', () => {
  it('draws the railing with the no-climb band and all four checks', () => {
    render(
      <GuardrailCheckCard
        title="Absturzsicherung Dachterrasse"
        context="dachterrasse"
        fall_height={{
          label: 'Absturzhöhe',
          value: 13.5,
          required: 12,
          unit: 'm',
          comparator: '<=',
          status: 'warning',
        }}
        rail_height={{
          label: 'Geländerhöhe',
          value: 110,
          required: 110,
          unit: 'cm',
          comparator: '>=',
          status: 'pass',
        }}
        max_opening={{
          label: 'max. Öffnungsweite',
          value: 11,
          required: 12,
          unit: 'cm',
          comparator: '<=',
          status: 'pass',
        }}
        bottom_gap={{
          label: 'Bodenspalt',
          value: 4,
          required: 12,
          unit: 'cm',
          comparator: '<=',
          status: 'pass',
        }}
        has_horizontal_elements_in_climb_zone={false}
        reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 4.3', edition: 'Ausgabe Mai 2023' }}
      />
    )

    expect(screen.getByText('ANSICHT · DACHTERRASSE')).toBeInTheDocument()
    expect(screen.getByText('Kletterschutz 15–60 cm')).toBeInTheDocument()
    expect(screen.getByText('Geländerhöhe')).toBeInTheDocument()
    expect(screen.getByText('Bodenspalt')).toBeInTheDocument()
    expect(screen.getAllByText('110 cm').length).toBeGreaterThanOrEqual(1)
    // fall_height > 12 m surfaces the stricter 110 cm minimum next to the drop.
    expect(screen.getByText(/mind\. 110 cm/)).toBeInTheDocument()
    expect(screen.getByText('grenzwertig')).toBeInTheDocument()
  })

  it('warns about climbable horizontals in the climb zone', () => {
    render(
      <GuardrailCheckCard
        title="Absturzsicherung Balkon"
        context="balkon"
        fall_height={{ label: 'Absturzhöhe', value: 6, unit: 'm', status: 'pass' }}
        rail_height={{ label: 'Geländerhöhe', value: null, required: 100, unit: 'cm', comparator: '>=', status: 'needs_input' }}
        max_opening={{ label: 'max. Öffnungsweite', value: 12, required: 12, unit: 'cm', comparator: '<=', status: 'pass' }}
        has_horizontal_elements_in_climb_zone={true}
        reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 4.3' }}
      />
    )

    expect(
      screen.getByText(
        'Horizontale, zum Aufklettern geeignete Elemente im Kletterschutzbereich (15–60 cm).'
      )
    ).toBeInTheDocument()
    expect(screen.getAllByText('fehlende Angabe').length).toBeGreaterThanOrEqual(1)
  })
})

describe('DensityCheckCard', () => {
  it('derives coverage and GFZ from the areas and settles needs_input statuses', () => {
    render(
      <DensityCheckCard
        title="Bebauungsdichte – Grundstück"
        parcel_area_m2={800}
        footprint_area_m2={240}
        gross_floor_area_m2={720}
        coverage={{
          label: 'Bebauungsgrad',
          value: null,
          required: 30,
          unit: '%',
          comparator: '<=',
          status: 'needs_input',
        }}
        density={{
          label: 'GFZ',
          value: null,
          required: 1.2,
          comparator: '<=',
          status: 'needs_input',
        }}
        reference={{ document: 'Bebauungsplan Nr. 7710', section: '§ 4' }}
      />
    )

    expect(screen.getByText('Grundstück 800 m²')).toBeInTheDocument()
    // Renderer-derived ratios: 240/800 → 30 %, 720/800 → 0.9 GFZ, both within
    // limits. The coverage ratio appears twice: in the plan and on its bar.
    expect(screen.getAllByText(/^30 %/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/^0,9/)).toBeInTheDocument()
    expect(screen.getByText('erfüllt')).toBeInTheDocument()
    expect(screen.getByText(/720 m²/)).toBeInTheDocument()
    expect(screen.getByText('Bebauungsplan Nr. 7710')).toBeInTheDocument()
  })

  it('reads needs_input when the areas are missing, never a guessed ratio', () => {
    render(
      <DensityCheckCard
        title="Bebauungsdichte – offene Angaben"
        parcel_area_m2={650}
        coverage={{ label: 'Bebauungsgrad', value: null, required: 25, unit: '%', comparator: '<=', status: 'needs_input' }}
        density={{ label: 'GFZ', value: null, required: 1, comparator: '<=', status: 'needs_input' }}
        reference={{ document: 'Bebauungsplan' }}
      />
    )

    expect(screen.getByText(/bebaute Fläche: fehlende Angabe/)).toBeInTheDocument()
    expect(screen.getAllByText('fehlende Angabe').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Angabe fehlt')).toBeInTheDocument()
  })
})

describe('FireAccessPlanCard', () => {
  it('draws route, Aufstellfläche, and reach arrow with every check listed', () => {
    render(
      <FireAccessPlanCard
        title="Feuerwehrzufahrt & Aufstellfläche"
        parcel_width_m={28}
        parcel_depth_m={40}
        building_width_m={14}
        building_depth_m={12}
        route_width={{
          label: 'Zufahrt Breite',
          value: 3.5,
          required: 3,
          unit: 'm',
          comparator: '>=',
          status: 'pass',
        }}
        gate_clearance_height={{
          label: 'Durchfahrt lichte Höhe',
          value: 3.8,
          required: 3.5,
          unit: 'm',
          comparator: '>=',
          status: 'pass',
        }}
        aufstellflaeche={{
          width: { label: 'Aufstellfläche Breite', value: 5, required: 5, unit: 'm', comparator: '>=', status: 'pass' },
          length: { label: 'Aufstellfläche Länge', value: 11, required: 10, unit: 'm', comparator: '>=', status: 'pass' },
          distance_to_facade: { label: 'Abstand zur Fassade', value: 1, unit: 'm', status: 'pass' },
        }}
        walk_distance_to_entrance={{
          label: 'Weg zum Eingang',
          value: 62,
          required: 80,
          unit: 'm',
          comparator: '<=',
          status: 'pass',
        }}
        gebaeudeklasse="GK 4"
        reference={{ document: 'OIB-Richtlinie 2', section: 'Pkt. 8.2', edition: 'Ausgabe Mai 2023' }}
      />
    )

    expect(screen.getByText('ZUFAHRT')).toBeInTheDocument()
    expect(screen.getAllByText(/Aufstellfläche/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Eingang')).toBeInTheDocument()
    expect(screen.getByText('STRASSE')).toBeInTheDocument()
    expect(screen.getAllByText('62 m').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Durchfahrt lichte Höhe')).toBeInTheDocument()
    expect(screen.getAllByText('GK 4').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('erfüllt')).toBeInTheDocument()
  })
})

describe('AcousticCheckCard', () => {
  it('orients airborne and impact gauges and computes the dB margins', () => {
    render(
      <AcousticCheckCard
        title="Schallschutz – Wohnungstrennung"
        sound_class="Klasse C"
        checks={[
          {
            path_label: 'Wohnungstrennwand Top 3/Top 4',
            metric: 'DnTw',
            check: {
              label: 'DnT,w',
              value: 57,
              required: 55,
              unit: 'dB',
              comparator: '>=',
              status: 'pass',
            },
            reference: { document: 'OIB-Richtlinie 5', section: 'Pkt. 2.2', edition: 'Ausgabe Mai 2023' },
          },
          {
            path_label: 'Wohnungstrenndecke Top 3/Top 7',
            metric: 'LnTw',
            check: {
              label: 'LnT,w',
              value: 50,
              required: 48,
              unit: 'dB',
              comparator: '<=',
              status: 'fail',
            },
            reference: { document: 'ÖNORM B 8115-2', section: 'Tab. 3' },
          },
        ]}
      />
    )

    expect(screen.getByText('Wohnungstrennwand Top 3/Top 4')).toBeInTheDocument()
    expect(screen.getByText('↑ höher ist besser')).toBeInTheDocument()
    expect(screen.getByText('↓ niedriger ist besser')).toBeInTheDocument()
    // Renderer-computed, direction-aware margins: 57−55 = +2, 48−50 = −2.
    expect(screen.getByText('Reserve +2 dB')).toBeInTheDocument()
    expect(screen.getByText('Fehlbetrag 2 dB')).toBeInTheDocument()
    expect(screen.getByText('Klasse C')).toBeInTheDocument()
    // Worst status wins the verdict; the diverging reference shows inline.
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
    expect(screen.getByText('OIB-Richtlinie 5')).toBeInTheDocument()
    expect(screen.getByText(/ÖNORM B 8115-2/)).toBeInTheDocument()
  })
})

describe('FireCompartmentCard', () => {
  it('draws each compartment, flags an oversized one, and lists the area checks', () => {
    render(
      <FireCompartmentCard
        title="Brandabschnitte – Regelgeschoss"
        storey_label="2.OG"
        gebaeudeklasse="GK 5"
        compartments={[
          {
            label: 'BA 1',
            use: 'Wohnen',
            area: { label: 'BA 1', value: 1200, required: 1600, unit: 'm²', comparator: '<=', status: 'pass' },
          },
          {
            label: 'BA 2',
            use: 'Büro',
            area: { label: 'BA 2', value: 1850, required: 1600, unit: 'm²', comparator: '<=', status: 'fail' },
          },
        ]}
        reference={{ document: 'OIB-Richtlinie 2', section: 'Pkt. 3.1', edition: 'Ausgabe Mai 2023' }}
      />
    )

    expect(screen.getByText('Geschoss 2.OG · GK 5')).toBeInTheDocument()
    expect(screen.getAllByText('BA 1').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
    expect(screen.getByText('OIB-Richtlinie 2')).toBeInTheDocument()
  })
})

describe('ThermalEnvelopeCard', () => {
  it('reads each component U-value against its limit and flags a failing wall', () => {
    render(
      <ThermalEnvelopeCard
        title="Wärmeschutz – U-Werte der Gebäudehülle"
        components={[
          {
            label: 'Außenwand',
            kind: 'wall',
            u_value: { label: 'Außenwand', value: 0.4, required: 0.35, unit: 'W/(m²K)', comparator: '<=', status: 'fail' },
          },
          {
            label: 'Dach',
            kind: 'roof',
            u_value: { label: 'Dach', value: 0.18, required: 0.2, unit: 'W/(m²K)', comparator: '<=', status: 'pass' },
          },
        ]}
        reference={{ document: 'OIB-Richtlinie 6', section: 'Tabelle 3', edition: 'Ausgabe Mai 2023' }}
      />
    )

    // Each checked component gets a status callout in the section plus its
    // limit bar below.
    expect(screen.getAllByText('Außenwand').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Dach').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
    expect(screen.getByText('OIB-Richtlinie 6')).toBeInTheDocument()
  })
})

describe('EnergyPerformanceCard', () => {
  it('places the HWB on the class ladder and reads it against the limit', () => {
    render(
      <EnergyPerformanceCard
        title="Energieausweis – Heizwärmebedarf"
        energy_class="B"
        hwb={{
          label: 'Heizwärmebedarf (HWB)',
          value: 42,
          required: 54.4,
          unit: 'kWh/m²a',
          comparator: '<=',
          status: 'pass',
        }}
        reference={{ document: 'OIB-Richtlinie 6', section: 'Pkt. 4', edition: 'Ausgabe Mai 2023' }}
      />
    )

    expect(screen.getByText('A++')).toBeInTheDocument()
    expect(screen.getByText('G')).toBeInTheDocument()
    expect(screen.getByText(/HWB 42/)).toBeInTheDocument()
    expect(screen.getByText('erfüllt')).toBeInTheDocument()
    expect(screen.getByText('OIB-Richtlinie 6')).toBeInTheDocument()
  })
})

describe('ElevatorRequirementCard', () => {
  it('states the requirement and checks the cabin dimensions', () => {
    render(
      <ElevatorRequirementCard
        title="Barrierefreier Aufzug – Erschließung"
        storeys_served={5}
        entrance_level_index={0}
        is_required={true}
        requirement_note="Mehr als zwei oberirdische Geschoße → barrierefreier Aufzug erforderlich."
        cabin_width={{ label: 'Kabinenbreite', value: 110, required: 110, unit: 'cm', comparator: '>=', status: 'pass' }}
        cabin_depth={{ label: 'Kabinentiefe', value: null, required: 140, unit: 'cm', comparator: '>=', status: 'needs_input' }}
        reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 2.3', edition: 'Ausgabe Mai 2023' }}
      />
    )

    expect(screen.getByText('erforderlich')).toBeInTheDocument()
    expect(screen.getByText('Zugangsebene')).toBeInTheDocument()
    expect(screen.getByText('Kabinenbreite')).toBeInTheDocument()
    expect(screen.getByText('fehlende Angabe')).toBeInTheDocument()
    expect(screen.getByText('OIB-Richtlinie 4')).toBeInTheDocument()
  })
})

describe('ParkingRequirementCard', () => {
  it('reads provided car spaces against the required minimum', () => {
    render(
      <ParkingRequirementCard
        title="Stellplatznachweis – Wohnbau"
        basis="1 Stpl. je 100 m² BGF"
        car_spaces={{
          label: 'Kfz-Stellplätze',
          value: 8,
          required: 10,
          unit: 'Stpl.',
          comparator: '>=',
          status: 'fail',
        }}
        bicycle_spaces={{
          label: 'Fahrradabstellplätze',
          value: 20,
          required: 16,
          unit: 'Stpl.',
          comparator: '>=',
          status: 'pass',
        }}
        reference={{ document: 'Wiener Garagengesetz', section: '§ 48' }}
      />
    )

    expect(screen.getAllByText('Kfz-Stellplätze').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Fahrradabstellplätze').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/1 Stpl. je 100 m² BGF/)).toBeInTheDocument()
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
    expect(screen.getByText('Wiener Garagengesetz')).toBeInTheDocument()
  })
})

/**
 * The provenance of a number, which the card used to drop on the floor.
 *
 * `ifc_measure` answers „gemessen: 2,47 m (±5 mm) — aus der Geometrie
 * berechnet, nicht deklariert", the assistant repeats that in the prose, and
 * this card drew **2,47 m ✓** beside it — indistinguishable from a figure the
 * architect had stated in their own file. A card is the part a reviewer
 * screenshots into a submission, so the surface that dropped the qualifier was
 * the one most likely to be forwarded without it.
 */
describe('a measured number carries where it came from', () => {
  it('separates our measurement from the architect’s own statement', () => {
    render(
      <DimensionDiagramCard
        title="Türdurchgang"
        shape="door"
        dimensions={[
          {
            label: 'Rohbaulichte',
            value: 90,
            required: 80,
            unit: 'cm',
            comparator: '>=',
            status: 'pass',
            provenance: 'computed',
            tolerance: 0.5,
          },
          {
            label: 'Türhöhe laut Schedule',
            value: 211,
            required: 200,
            unit: 'cm',
            comparator: '>=',
            status: 'pass',
            provenance: 'declared',
          },
        ]}
        reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 2.1' }}
      />
    )

    expect(screen.getByText('gemessen')).toBeInTheDocument()
    expect(screen.getByText('±0,5 cm')).toBeInTheDocument()
    expect(screen.getByText('laut Modell')).toBeInTheDocument()
  })

  it('shows no band for a declared figure, because the tolerance is not ours', () => {
    render(
      <DimensionDiagramCard
        title="Türdurchgang"
        shape="door"
        dimensions={[
          {
            label: 'Türbreite',
            value: 90,
            unit: 'cm',
            status: 'pass',
            provenance: 'declared',
            tolerance: 0.5,
          },
        ]}
        reference={{ document: 'OIB-Richtlinie 4' }}
      />
    )

    expect(screen.getByText('laut Modell')).toBeInTheDocument()
    expect(screen.queryByText('±0,5 cm')).not.toBeInTheDocument()
  })

  it('prints the CAD remedy instead of an empty slot when the export cannot say', () => {
    render(
      <DimensionDiagramCard
        title="Türdurchgang"
        shape="door"
        dimensions={[
          {
            label: 'Lichte Durchgangsbreite',
            value: null,
            required: 80,
            unit: 'cm',
            comparator: '>=',
            status: 'needs_input',
            missing: 'Die Tür trägt kein IfcOpeningElement mit Geometrie — im CAD als Öffnung modellieren.',
          },
        ]}
        reference={{ document: 'OIB-Richtlinie 4' }}
      />
    )

    // Twice on purpose: once on the drawing where the dimension would have
    // been, once in the legend. Both are the absence; only the legend can carry
    // the remedy, which is why the remedy is asserted separately.
    expect(screen.getAllByText('fehlende Angabe').length).toBeGreaterThan(0)
    expect(screen.getByText(/im CAD als Öffnung modellieren/)).toBeInTheDocument()
  })
})

describe('the tolerance band against the limit', () => {
  it('says the check is undecided when the band straddles the limit', () => {
    /**
     * The one thing this bar can say faster than a sentence can. A value whose
     * ± band crosses the threshold is on BOTH sides of the line at the
     * precision we actually have, and a bar that filled it green or red would
     * assert a verdict the measurement does not support.
     */
    render(
      <EnergyPerformanceCard
        title="Energieausweis"
        hwb={{
          label: 'Heizwärmebedarf',
          value: 54,
          required: 55,
          unit: 'kWh/(m²a)',
          comparator: '<=',
          status: 'warning',
          provenance: 'computed',
          tolerance: 3,
        }}
        reference={{ document: 'OIB-Richtlinie 6' }}
      />
    )

    expect(screen.getByText(/Messtoleranz reicht über den Grenzwert/)).toBeInTheDocument()
    expect(screen.getByText(/genauer aufmessen/)).toBeInTheDocument()
  })

  it('stays quiet when the band clears the limit outright', () => {
    render(
      <EnergyPerformanceCard
        title="Energieausweis"
        hwb={{
          label: 'Heizwärmebedarf',
          value: 40,
          required: 55,
          unit: 'kWh/(m²a)',
          comparator: '<=',
          status: 'pass',
          provenance: 'computed',
          tolerance: 3,
        }}
        reference={{ document: 'OIB-Richtlinie 6' }}
      />
    )

    expect(screen.queryByText(/Messtoleranz reicht über den Grenzwert/)).not.toBeInTheDocument()
    // The band is still shown — it qualifies the number whether or not it
    // changes the verdict.
    expect(screen.getByText('±3 kWh/(m²a)')).toBeInTheDocument()
  })
})
