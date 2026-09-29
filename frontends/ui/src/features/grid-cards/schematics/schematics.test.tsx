/**
 * Render tests for the schematic Grid cards: realistic OIB parameter
 * sets in, deterministic SVG + verdict chrome out. Focus: to-scale rendering
 * never throws, statuses surface as German verdicts, unknown values read
 * "fehlende Angabe" instead of a guessed number, and the NormReference
 * footer grounds every drawn limit.
 */

import { describe, expect, it } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import { BuildingSectionCard } from './BuildingSectionCard'
import { StairDiagramCard } from './StairDiagramCard'
import { LimitBar } from './kit'
import { DimensionDiagramCard } from './DimensionDiagramCard'
import { SetbackPlanCard } from './SetbackPlanCard'
import { EgressDiagramCard } from './EgressDiagramCard'
import { DaylightIncidenceCard } from './DaylightIncidenceCard'
import { GuardrailCheckCard } from './GuardrailCheckCard'
import { FireAccessPlanCard } from './FireAccessPlanCard'

/**
 * The cards render in German because the reader is Austrian, and the copy now
 * comes from the dictionary rather than from literals in the components. A
 * test that renders without a provider sees the default locale (`en`), so the
 * locale is pinned here; `fixedLocale` also skips the provider's preference
 * reconciliation, which would be a fetch.
 */
const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

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
      <LimitBar
        check={{
          label: 'Heizwärmebedarf',
          value: 54,
          required: 55,
          unit: 'kWh/(m²a)',
          comparator: '<=',
          status: 'warning',
          provenance: 'computed',
          tolerance: 3,
        }}
      />
    )

    expect(screen.getByText(/Messtoleranz reicht über den Grenzwert/)).toBeInTheDocument()
    expect(screen.getByText(/genauer aufmessen/)).toBeInTheDocument()
  })

  it('stays quiet when the whole band satisfies an inclusive limit', () => {
    /**
     * 54 ±3 against „≤ 55" warns, because 57 fails it. 50 ±5 against the same
     * limit must NOT: every value in [45, 55] meets a „≤ 55", and the endpoint
     * is inside the limit, not across it. The first version tested `hi >=
     * required` and warned here.
     */
    render(
      <LimitBar
        check={{
          label: 'Heizwärmebedarf',
          value: 50,
          required: 55,
          unit: 'kWh/(m²a)',
          comparator: '<=',
          status: 'pass',
          provenance: 'computed',
          tolerance: 5,
        }}
      />
    )
    expect(screen.queryByText(/Messtoleranz reicht über den Grenzwert/)).not.toBeInTheDocument()
  })

  it('still warns at the same endpoint when the limit points the other way', () => {
    /**
     * The half a symmetric strict test gets wrong. 50 ±5 against „≥ 55" reaches
     * the limit at its top end and fails everywhere below it, so it IS
     * undecided — and a rule written as `lo < required && hi > required`, which
     * fixes the case above, silently stops warning here.
     */
    render(
      <LimitBar
        check={{
          label: 'Breite',
          value: 50,
          required: 55,
          unit: 'cm',
          comparator: '>=',
          status: 'warning',
          provenance: 'computed',
          tolerance: 5,
        }}
      />
    )
    expect(screen.getByText(/Messtoleranz reicht über den Grenzwert/)).toBeInTheDocument()
  })

  it('says nothing about crossing when no comparator gives the limit a direction', () => {
    /**
     * Every card that uses the bar defaults the comparator (`comparator ??
     * '<='`), so a null one is unreachable through a card. The branch is
     * defensive, and the bar is the level at which it is real.
     */
    render(<LimitBar check={{ label: 'Breite', value: 54, required: 55, unit: 'cm', status: 'warning',
                              provenance: 'computed', tolerance: 3 }} />)
    expect(screen.queryByText(/Messtoleranz reicht über den Grenzwert/)).not.toBeInTheDocument()
    // The band itself is still shown: it qualifies the number either way.
    expect(screen.getByText('±3 cm')).toBeInTheDocument()
  })

  it('stays quiet when the band clears the limit outright', () => {
    render(
      <LimitBar
        check={{
          label: 'Heizwärmebedarf',
          value: 40,
          required: 55,
          unit: 'kWh/(m²a)',
          comparator: '<=',
          status: 'pass',
          provenance: 'computed',
          tolerance: 3,
        }}
      />
    )

    expect(screen.queryByText(/Messtoleranz reicht über den Grenzwert/)).not.toBeInTheDocument()
    // The band is still shown — it qualifies the number whether or not it
    // changes the verdict.
    expect(screen.getByText('±3 kWh/(m²a)')).toBeInTheDocument()
  })
})

describe('a drawing fits the card it is printed in', () => {
  const SHAPES = ['door', 'ramp', 'corridor', 'turning_circle', 'threshold', 'parking_space'] as const

  /**
   * A schematic is geometry, not a styled box: whatever the SVG does not have
   * room for is cut off at the card edge, and the part that goes missing is
   * the outer gutter where the dimension arrows and their numbers are placed.
   * The canvas therefore may never ask for more width than it is given — no
   * pixel floor, no intrinsic width — so on a phone the drawing shrinks and
   * stays whole instead of running past the edge with a number on it.
   */
  it.each(SHAPES)('the %s drawing never claims a width the card cannot give', (shape) => {
    const { container } = render(
      <DimensionDiagramCard
        title="Skizze"
        shape={shape}
        dimensions={[
          { label: 'Breite', value: 120, required: 120, unit: 'cm', comparator: '>=', status: 'pass' },
          { label: 'Höhe', value: 210, required: 200, unit: 'cm', comparator: '>=', status: 'pass' },
        ]}
      />
    )

    const svg = container.querySelector('svg[role="img"]') as SVGSVGElement
    expect(svg.style.minWidth).toBe('')
    expect(svg.getAttribute('class')).toContain('w-full')
  })

  /**
   * And it may not be blown up without limit either: the drawings are authored
   * in units that behave like pixels, so a narrow one stretched to fill a wide
   * column turns two numbers into several hundred pixels of picture. The cap
   * is a plain multiple of the authored width, which keeps the scale uniform —
   * every ratio the drawing asserts survives it.
   */
  it('caps how far a narrow drawing is blown up, in proportion to how it was drawn', () => {
    const { container } = render(
      <DimensionDiagramCard
        title="Wendekreis"
        shape="turning_circle"
        dimensions={[
          { label: 'Durchmesser', value: 150, required: 150, unit: 'cm', comparator: '>=', status: 'pass' },
        ]}
      />
    )

    const svg = container.querySelector('svg[role="img"]') as SVGSVGElement
    const viewW = Number(svg.getAttribute('viewBox')!.split(' ')[2])
    const maxWidth = Number.parseFloat(svg.style.maxWidth)

    expect(maxWidth).toBeGreaterThan(viewW)
    expect(maxWidth / viewW).toBeLessThanOrEqual(1.5)
  })
})
