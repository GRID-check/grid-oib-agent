'use client'

/**
 * Card-gallery dev page: renders every Grid card type with realistic fixture
 * data so visual changes can be reviewed (and screenshotted) in one place.
 * Not linked from anywhere and returns 404 outside development.
 *
 * The whole gallery is pinned to German with `fixedLocale`. Without it the
 * provider falls back to `defaultLocale` ('en'), which is how the committed
 * screenshot came to show an English „Ask about this" chip in the middle of a
 * German Anforderungsliste: the cards whose copy is hardcoded German looked
 * right and only the translated ones leaked. See docs/ux/visual-screenshots.md.
 */

import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { SummaryCard } from '@/features/grid-cards/components/SummaryCard'
import { KeyTakeawaysCard } from '@/features/grid-cards/components/KeyTakeawaysCard'
import { ConditionTreeCard } from '@/features/grid-cards/components/ConditionTreeCard'
import { CalloutCard } from '@/features/grid-cards/components/CalloutCard'
import { FollowUpsCard } from '@/features/grid-cards/components/FollowUpsCard'
import { LegalBasisCard } from '@/features/grid-cards/components/LegalBasisCard'
import { RequirementChecklistCard } from '@/features/grid-cards/components/RequirementChecklistCard'
import { ComparisonTableCard } from '@/features/grid-cards/components/ComparisonTableCard'
import { BuildingSectionCard } from '@/features/grid-cards/schematics/BuildingSectionCard'
import { StairDiagramCard } from '@/features/grid-cards/schematics/StairDiagramCard'
import { DimensionDiagramCard } from '@/features/grid-cards/schematics/DimensionDiagramCard'
import { SetbackPlanCard } from '@/features/grid-cards/schematics/SetbackPlanCard'
import { EgressDiagramCard } from '@/features/grid-cards/schematics/EgressDiagramCard'
import { DaylightIncidenceCard } from '@/features/grid-cards/schematics/DaylightIncidenceCard'
import { GuardrailCheckCard } from '@/features/grid-cards/schematics/GuardrailCheckCard'
import { DensityCheckCard } from '@/features/grid-cards/schematics/DensityCheckCard'
import { FireAccessPlanCard } from '@/features/grid-cards/schematics/FireAccessPlanCard'
import { AcousticCheckCard } from '@/features/grid-cards/schematics/AcousticCheckCard'
import { FireCompartmentCard } from '@/features/grid-cards/schematics/FireCompartmentCard'
import { ThermalEnvelopeCard } from '@/features/grid-cards/schematics/ThermalEnvelopeCard'
import { EnergyPerformanceCard } from '@/features/grid-cards/schematics/EnergyPerformanceCard'
import { ElevatorRequirementCard } from '@/features/grid-cards/schematics/ElevatorRequirementCard'
import { ParkingRequirementCard } from '@/features/grid-cards/schematics/ParkingRequirementCard'
import { GridCards } from '@/features/grid-cards/components/GridCards'
import type { GridCard } from '@/shared/cards/schemas'

const OIB2 = { document: 'OIB-Richtlinie 2', section: 'Pkt. 3.1', edition: 'Ausgabe Mai 2023' }
const OIB3 = { document: 'OIB-Richtlinie 3', section: 'Pkt. 9.1.1', edition: 'Ausgabe Mai 2023' }
const OIB4 = { document: 'OIB-Richtlinie 4', section: 'Pkt. 2.2', edition: 'Ausgabe Mai 2023' }
const OIB6 = { document: 'OIB-Richtlinie 6', section: 'Pkt. 4.2', edition: 'Ausgabe Mai 2023' }

const Section = ({ id, children }: { id: string; children: React.ReactNode }) => (
  <section id={id} data-card={id} className="flex flex-col gap-2">
    <h2 className="font-mono text-xs text-muted-foreground">{id}</h2>
    {children}
  </section>
)

export default function CardsGalleryPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Gallery />
    </I18nProvider>
  )
}

function Gallery() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <h1 className="text-lg font-semibold">Grid card gallery</h1>

      <Section id="summary">
        <SummaryCard
          type="summary"
          title="Gebäudeklasse 4 – Anforderungen im Überblick"
          content="Für Ihr Wohngebäude mit Fluchtniveau 9,8 m gilt Gebäudeklasse 4. Daraus folgen erhöhte Anforderungen an Brandschutz und Erschließung."
          key_points={[
            'Fluchtniveau 9,8 m → GK 4 (Grenze: 11 m)',
            'Treppenhaus als gesicherter Fluchtbereich erforderlich',
            'Barrierefreier Aufzug ab 3 oberirdischen Geschossen',
          ]}
        />
      </Section>

      <Section id="key_takeaways">
        <KeyTakeawaysCard
          title="Gebäudeklasse 4 – was daraus folgt"
          items={[
            {
              text: 'Fluchtniveau 9,80 m → Gebäudeklasse 4',
              detail:
                'Maßgeblich ist das oberste Fluchtniveau über dem angrenzenden Gelände; die Grenze zu GK 5 liegt bei 11 m.',
            },
            {
              text: 'Tragende Bauteile mindestens REI 60',
              detail: 'In Kellergeschossen gilt REI 90, unabhängig von der Gebäudeklasse.',
            },
            {
              text: 'Treppenhaus als gesicherter Fluchtbereich erforderlich',
              detail:
                'Rauchdichte Abtrennung in jedem Geschoss; die Ausführung ist mit der Brandschutzplanung abzustimmen.',
            },
            { text: 'Barrierefreier Aufzug ab drei oberirdischen Geschossen' },
          ]}
        />
      </Section>

      {/* All four kinds side by side: the word carries the signal, the tone
          only reinforces it — which is exactly what has to be reviewable in
          both themes at once. */}
      <Section id="callout">
        <CalloutCard
          kind="hinweis"
          text="Für Zu- und Umbauten im Bestand gelten die Anforderungen nur im Umfang des Eingriffs."
          detail="Wird die Gebäudeklasse durch den Zubau angehoben, ist das gesamte Gebäude neu zu beurteilen."
        />
        <CalloutCard
          kind="achtung"
          title="Gilt nur in Wien"
          text="Die Wiener Bauordnung weicht bei der Berechnung des Fluchtniveaus von den übrigen Ländern ab."
        />
        <CalloutCard
          kind="frist"
          text="Die Bauverhandlung ist binnen sechs Wochen nach Einreichung anzuberaumen."
          detail="Die Frist ruht, solange die Behörde eine Ergänzung des Einreichplans verlangt hat."
        />
        <CalloutCard
          kind="tipp"
          text="Ein Schnitt durch das Treppenhaus mit eingetragenem Fluchtniveau erspart in der Regel eine Rückfrage der Behörde."
        />
      </Section>

      {/* Four chips of very different lengths, because the thing to review here
          is that a long question truncates to one line instead of turning the
          chip into a paragraph — and that the set still reads as an offer. */}
      <Section id="follow_ups">
        <FollowUpsCard
          title="Weiterführende Fragen"
          items={[
            { question: 'Wie wird das Fluchtniveau genau gemessen?', hint: 'Messpunkt und Bezugsebene' },
            { question: 'Welche Anforderungen gelten für mein Projekt konkret?' },
            { question: 'Was wäre bei Gebäudeklasse 5 anders?', hint: 'Vergleich der beiden Klassen' },
            {
              question:
                'Wie weise ich die Feuerwiderstandsklasse REI 60 der tragenden Bauteile im Einreichplan nach?',
            },
          ]}
        />
      </Section>

      {/* At rest: the case that applies is open, the others are one line each.
          The switched state — a different case previewed against it — is its
          own target, /dev/condition-tree. */}
      <Section id="condition_tree">
        <ConditionTreeCard
          title="Erforderliche Feuerwiderstandsklasse tragender Bauteile"
          question="Gebäudeklasse"
          branches={[
            { condition: 'GK 1–3', outcome: 'REI 30 (bzw. R 30)' },
            {
              condition: 'GK 4',
              outcome: 'REI 60',
              active: true,
              reference: {
                document: 'OIB-Richtlinie 2',
                section: 'Tabelle 1b',
                excerpt:
                  'Tragende Bauteile in Gebäuden der Gebäudeklasse 4 sind in REI 60 auszuführen; in Kellergeschossen gilt REI 90.',
              },
            },
            {
              condition: 'GK 5',
              outcome: 'REI 90',
              reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
            },
          ]}
          reference={{ document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', edition: 'Ausgabe Mai 2023' }}
        />
      </Section>

      <Section id="legal_basis">
        <LegalBasisCard
          type="legal_basis"
          law="OIB-Richtlinie 2"
          article="3.1.1"
          section="Tabelle 1a"
          summary="Die maximale Brandabschnittsfläche für oberirdische Geschosse in GK 4 beträgt 1.200 m²."
          original_text="Brandabschnitte dürfen eine Nettogrundfläche von höchstens 1.200 m² und eine Längenausdehnung von höchstens 60 m aufweisen."
        />
      </Section>

      <Section id="requirement_checklist">
        <RequirementChecklistCard
          title="Anforderungen GK 4 – Brandschutz"
          items={[
            {
              label: 'Tragende Bauteile REI 60',
              status: 'pass',
              detail: 'Stahlbetondecken und -wände erfüllen REI 90.',
              reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
            },
            {
              label: 'Treppenhaus als gesicherter Fluchtbereich',
              status: 'fail',
              detail: 'Derzeit keine rauchdichte Abtrennung im EG vorgesehen.',
              reference: { document: 'OIB-Richtlinie 2.3', section: 'Pkt. 2.1' },
            },
            {
              label: 'Zweiter Fluchtweg oder Anleiterbarkeit',
              status: 'needs_input',
              detail: 'Anleiterbarkeit der Nordfassade noch nicht geklärt.',
            },
            { label: 'Brandmeldeanlage Kategorie 1', status: 'warning' },
          ]}
          reference={{ document: 'OIB-Richtlinie 2', edition: 'Ausgabe Mai 2023' }}
          note="Bewertung auf Basis des Vorentwurfs vom 12.06."
        />
      </Section>

      <Section id="comparison_table">
        <ComparisonTableCard
          title="GK 4 vs. GK 5 – wesentliche Anforderungen"
          options={['GK 4', 'GK 5']}
          rows={[
            { label: 'Fluchtniveau', values: ['≤ 11 m', '≤ 22 m'], highlight_index: 0 },
            { label: 'Tragende Bauteile', values: ['REI 60', 'REI 90'], highlight_index: 0 },
            { label: 'max. Brandabschnittsfläche', values: ['1.200 m²', '1.200 m²'] },
            { label: 'Aufzug erforderlich', values: ['ab 3 Geschossen', 'ja'], highlight_index: 0 },
          ]}
          recommendation="Mit Fluchtniveau 9,8 m bleibt das Projekt in GK 4 — deutlich geringere Anforderungen an tragende Bauteile."
          reference={{ document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', edition: 'Ausgabe Mai 2023' }}
        />
      </Section>

      <Section id="building_section">
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
          reference={OIB2}
          note="Das Fluchtniveau liegt unter der GK4-Grenze von 11 m."
        />
      </Section>

      <Section id="stair_diagram">
        <StairDiagramCard
          title="Treppenlauf – Steigungsverhältnis"
          riser_count={17}
          riser_height={{ label: 'Steigung', value: 17.6, required: 18, unit: 'cm', comparator: '<=', status: 'pass' }}
          tread_depth={{ label: 'Auftritt', value: 28, required: 28, unit: 'cm', comparator: '>=', status: 'pass' }}
          width={{ label: 'Nutzbare Laufbreite', value: 110, required: 120, unit: 'cm', comparator: '>=', status: 'fail' }}
          comfort_note="Schrittmaß 2×17,6 + 28 = 63,2 cm — innerhalb der Komfortregel (59–65 cm)."
          reference={OIB4}
        />
      </Section>

      <Section id="dimension_diagram_door">
        <DimensionDiagramCard
          title="Türe – lichte Durchgangsbreite"
          shape="door"
          dimensions={[
            { label: 'lichte Durchgangsbreite', value: 85, required: 80, unit: 'cm', comparator: '>=', status: 'pass' },
            { label: 'Durchgangshöhe', value: 210, required: 200, unit: 'cm', comparator: '>=', status: 'pass' },
          ]}
          reference={{ document: 'ÖNORM B 1600', section: 'Pkt. 5.1.1' }}
        />
      </Section>

      {/* The legend at its most crowded, which is the state worth having on
          film: a measured value with its ± band, the „gemessen" provenance chip
          and the limit all in one `text-xs` row, plus the unanswerable check
          that prints the CAD remedy and offers the „Dazu fragen" chip. */}
      <Section id="dimension_diagram_ramp">
        <DimensionDiagramCard
          title="Rampe – Neigung & Breite"
          shape="ramp"
          dimensions={[
            {
              label: 'Neigung',
              value: 7.2,
              required: 6,
              unit: '%',
              comparator: '<=',
              status: 'fail',
              provenance: 'computed',
              tolerance: 0.1,
            },
            {
              label: 'nutzbare Breite',
              value: 120,
              required: 120,
              unit: 'cm',
              comparator: '>=',
              status: 'pass',
              provenance: 'declared',
            },
            {
              label: 'Handlauf beidseitig',
              value: null,
              unit: 'cm',
              status: 'needs_input',
              missing: 'Dieser Export enthält kein IfcRailing — Handläufe im CAD als IfcRailing modellieren.',
            },
          ]}
          reference={{ document: 'ÖNORM B 1600', section: 'Pkt. 5.2' }}
        />
      </Section>

      <Section id="dimension_diagram_turning_circle">
        <DimensionDiagramCard
          title="Wendekreis Rollstuhl"
          shape="turning_circle"
          dimensions={[
            { label: 'Durchmesser', value: 150, required: 150, unit: 'cm', comparator: '>=', status: 'pass' },
          ]}
          reference={{ document: 'ÖNORM B 1600' }}
        />
      </Section>

      <Section id="setback_plan">
        <SetbackPlanCard
          title="Abstandsflächen – Lageplan"
          parcel_width_m={22}
          parcel_depth_m={30}
          building_width_m={12}
          building_depth_m={14}
          sides={[
            { side: 'left', required_m: 3, actual_m: 2.4, status: 'fail' },
            { side: 'right', required_m: 3, actual_m: 4.2, status: 'pass' },
            { side: 'front', required_m: 5, actual_m: 6.0, status: 'pass' },
            { side: 'back', required_m: 3, actual_m: null, status: 'needs_input' },
          ]}
          reference={{ document: 'NÖ Bauordnung 2014', section: '§ 54' }}
        />
      </Section>

      <Section id="egress_diagram">
        <EgressDiagramCard
          title="Fluchtweg – Gehweglänge"
          segments={[
            { label: 'Raum → Gang', length_m: 12, turn: 'right' },
            { label: 'Gang', length_m: 18, turn: 'left' },
            { label: 'Gang → Treppenhaus', length_m: 8, turn: 'straight' },
          ]}
          total_length={{ label: 'Gehweglänge gesamt', value: 38, required: 40, unit: 'm', comparator: '<=', status: 'pass' }}
          reference={OIB2}
        />
      </Section>

      <Section id="daylight_incidence">
        <DaylightIncidenceCard
          title="Belichtung – freier Lichteinfall"
          room_floor_area_m2={22}
          glass_area={{ label: 'Lichteintrittsfläche', value: 2.6, required: 2.2, unit: 'm²', comparator: '>=', status: 'pass' }}
          window_sill_height_m={1.0}
          window_head_height_m={2.4}
          obstruction={{ distance_m: 6, height_m: 7.5, label: 'Gegenüberliegendes Gebäude' }}
          reference={OIB3}
        />
      </Section>

      <Section id="guardrail_check">
        <GuardrailCheckCard
          title="Absturzsicherung Dachterrasse"
          context="dachterrasse"
          fall_height={{ label: 'Absturzhöhe', value: 13.5, required: 12, unit: 'm', comparator: '<=', status: 'warning' }}
          rail_height={{ label: 'Geländerhöhe', value: 100, required: 110, unit: 'cm', comparator: '>=', status: 'fail' }}
          max_opening={{ label: 'max. Öffnungsweite', value: 11, required: 12, unit: 'cm', comparator: '<=', status: 'pass' }}
          bottom_gap={{ label: 'Bodenspalt', value: 3, required: 12, unit: 'cm', comparator: '<=', status: 'pass' }}
          has_horizontal_elements_in_climb_zone={false}
          reference={OIB4}
        />
      </Section>

      <Section id="density_check">
        <DensityCheckCard
          title="Bebauungsdichte – Grundstück"
          parcel_area_m2={800}
          footprint_area_m2={210}
          gross_floor_area_m2={620}
          coverage={{ label: 'Bebauungsgrad', value: null, required: 30, unit: '%', comparator: '<=', status: 'needs_input' }}
          density={{ label: 'GFZ', value: null, required: 0.8, unit: '', comparator: '<=', status: 'needs_input' }}
          reference={{ document: 'Bebauungsplan Mustergemeinde' }}
        />
      </Section>

      <Section id="fire_access_plan">
        <FireAccessPlanCard
          title="Feuerwehrzufahrt & Aufstellfläche"
          parcel_width_m={28}
          parcel_depth_m={36}
          building_width_m={16}
          building_depth_m={14}
          route_width={{ label: 'Zufahrt Breite', value: 3.5, required: 3, unit: 'm', comparator: '>=', status: 'pass' }}
          gate_clearance_height={{ label: 'Durchfahrt lichte Höhe', value: 4.0, required: 4.0, unit: 'm', comparator: '>=', status: 'pass' }}
          aufstellflaeche={{
            width: { label: 'Breite', value: 5, required: 5, unit: 'm', comparator: '>=', status: 'pass' },
            length: { label: 'Länge', value: 11, required: 10, unit: 'm', comparator: '>=', status: 'pass' },
            distance_to_facade: { label: 'Abstand zur Fassade', value: 3, required: 10, unit: 'm', comparator: '<=', status: 'pass' },
          }}
          walk_distance_to_entrance={{ label: 'Weg zum Eingang', value: 34, required: 80, unit: 'm', comparator: '<=', status: 'pass' }}
          gebaeudeklasse="GK 4"
          reference={{ document: 'TRVB F 134', section: 'Pkt. 4' }}
        />
      </Section>

      <Section id="acoustic_check">
        <AcousticCheckCard
          title="Schallschutz – Wohnungstrennung"
          checks={[
            {
              path_label: 'Wohnungstrennwand Top 3 / Top 4',
              metric: 'DnTw',
              check: { label: 'DnT,w', value: 56, required: 55, unit: 'dB', comparator: '>=', status: 'pass' },
              reference: { document: 'OIB-Richtlinie 5', section: 'Tabelle 1' },
            },
            {
              path_label: 'Wohnungstrenndecke Top 3 / Top 7',
              metric: 'LnTw',
              check: { label: 'LnT,w', value: 46, required: 48, unit: 'dB', comparator: '<=', status: 'pass' },
              reference: { document: 'OIB-Richtlinie 5', section: 'Tabelle 1' },
            },
            {
              path_label: 'Außenwand Straßenseite',
              metric: 'Rw_res',
              check: { label: 'Rw,res', value: 40, required: 43, unit: 'dB', comparator: '>=', status: 'fail' },
              reference: { document: 'ÖNORM B 8115-2', section: 'Tabelle 2' },
            },
          ]}
          sound_class="B"
        />
      </Section>

      <Section id="fire_compartment">
        <FireCompartmentCard
          title="Brandabschnitte – Regelgeschoss"
          storey_label="2.OG"
          compartments={[
            { label: 'BA 1', use: 'Wohnen', area: { label: 'BA 1', value: 980, required: 1200, unit: 'm²', comparator: '<=', status: 'pass' } },
            { label: 'BA 2', use: 'Büro', area: { label: 'BA 2', value: 1350, required: 1200, unit: 'm²', comparator: '<=', status: 'fail' } },
            { label: 'BA 3', use: 'Tiefgarage', area: { label: 'BA 3', value: null, required: 1200, unit: 'm²', comparator: '<=', status: 'needs_input' } },
          ]}
          gebaeudeklasse="GK 4"
          reference={{ document: 'OIB-Richtlinie 2', section: 'Tabelle 1a', edition: 'Ausgabe Mai 2023' }}
        />
      </Section>

      <Section id="thermal_envelope">
        <ThermalEnvelopeCard
          title="Wärmeschutz – U-Werte der Gebäudehülle"
          components={[
            { label: 'Außenwand', kind: 'wall', u_value: { label: 'Außenwand', value: 0.28, required: 0.35, unit: 'W/(m²K)', comparator: '<=', status: 'pass' } },
            { label: 'Dach', kind: 'roof', u_value: { label: 'Dach', value: 0.22, required: 0.2, unit: 'W/(m²K)', comparator: '<=', status: 'fail' } },
            { label: 'Fenster', kind: 'window', u_value: { label: 'Fenster', value: 1.1, required: 1.4, unit: 'W/(m²K)', comparator: '<=', status: 'pass' } },
            { label: 'Kellerdecke', kind: 'floor', u_value: { label: 'Kellerdecke', value: null, required: 0.4, unit: 'W/(m²K)', comparator: '<=', status: 'needs_input' } },
          ]}
          reference={OIB6}
        />
      </Section>

      <Section id="energy_performance">
        <EnergyPerformanceCard
          title="Energieausweis – Heizwärmebedarf"
          hwb={{ label: 'Heizwärmebedarf (HWB)', value: 42, required: 54.4, unit: 'kWh/m²a', comparator: '<=', status: 'pass' }}
          energy_class="B"
          fgee={{ label: 'fGEE', value: 0.82, required: 0.9, unit: '', comparator: '<=', status: 'pass' }}
          reference={OIB6}
        />
      </Section>

      <Section id="elevator_requirement">
        <ElevatorRequirementCard
          title="Barrierefreier Aufzug – Erschließung"
          storeys_served={5}
          entrance_level_index={0}
          is_required={true}
          requirement_note="Mehr als 2 oberirdische Geschosse: ein barrierefreier Aufzug ist erforderlich."
          cabin_width={{ label: 'Kabinenbreite', value: 110, required: 110, unit: 'cm', comparator: '>=', status: 'pass' }}
          cabin_depth={{ label: 'Kabinentiefe', value: 140, required: 140, unit: 'cm', comparator: '>=', status: 'pass' }}
          door_width={{ label: 'lichte Türbreite', value: 80, required: 90, unit: 'cm', comparator: '>=', status: 'fail' }}
          reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 2.5' }}
        />
      </Section>

      <Section id="parking_requirement">
        <ParkingRequirementCard
          title="Stellplatznachweis – Wohnbau"
          car_spaces={{ label: 'Kfz-Stellplätze', value: 12, required: 14, unit: 'Stpl.', comparator: '>=', status: 'fail' }}
          bicycle_spaces={{ label: 'Fahrradabstellplätze', value: 28, required: 24, unit: 'Stpl.', comparator: '>=', status: 'pass' }}
          basis="1 Stellplatz je Wohneinheit (14 WE)"
          reference={{ document: 'Wiener Garagengesetz 2008', section: '§ 48' }}
        />
      </Section>

      {/* The two INTERACTIVE cards (ADR-0030) go through the GridCards
          dispatcher rather than being rendered directly, so the gallery
          exercises the same `cardKey` wiring the chat uses. With no owning
          message they fall back to local state — clickable here, deliberately
          not durable. */}
      <Section id="project_profile_patch">
        <GridCards
          cards={[
            {
              type: 'project_profile_patch',
              title: 'Projektkontext aktualisieren: Fluchtniveau',
              rationale:
                'Sie haben angegeben, dass das oberste Fluchtniveau bei 25 m liegt — damit ist das Gebäude ein Hochhaus (> 22 m) und OIB-Richtlinie 2.3 wird anwendbar.',
              patch: [{ op: 'add', path: '/facts/fluchtniveau', value: '>22m' }],
            },
          ] as GridCard[]}
          projectId={null}
        />
      </Section>

      <Section id="memory_proposal">
        <GridCards
          cards={[
            {
              type: 'memory_proposal',
              title: 'Diese Erkenntnis merken?',
              content: 'Das Büro setzt bei GK 4 durchgängig REI 90 an, auch wo REI 60 genügen würde.',
              kind: 'preference',
              confidence: 'high',
            },
          ] as GridCard[]}
          projectId={null}
        />
      </Section>
    </main>
  )
}
