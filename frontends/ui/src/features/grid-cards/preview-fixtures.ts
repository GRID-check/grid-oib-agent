/**
 * Wire-shaped sample cards, one per type, for the platform card gallery.
 *
 * The catalog endpoint (`/api/platform/cards`) can describe a card's fields but
 * not what it LOOKS like, and a platform owner deciding whether Grid can
 * present their question is answering a visual question. These fixtures let the
 * gallery render each type through the real `GridCards` dispatcher — the same
 * path chat uses — so the page shows the actual component, not a mock of it.
 *
 * Deliberately in wire shape (`GridCard`, straight off the generated Zod
 * schema) rather than component props: a fixture that stops matching the schema
 * is a type error here, so the gallery cannot drift into showing a card the
 * agent could never emit.
 *
 * `preview-fixtures.spec.ts` fails when a card type has neither a fixture nor
 * an entry in {@link PREVIEW_EXCLUDED}, so a type added to the union is a
 * failing test rather than a silent hole in the gallery.
 *
 * Not shared with the `/dev/cards` gallery, which keeps its own inline
 * fixtures as frozen visual-regression baselines. These exist to be READ by a
 * platform owner, so they carry the hard states (a failing check, an unanswered
 * value) rather than a uniformly green picture.
 */

import { z } from 'zod'
import { gridCardSchema, validateGridCards, type GridCard } from '@/shared/cards/schemas'

/**
 * Fixtures are authored in the schema's INPUT shape — the generated schemas
 * `.default(null)` every optional field, so an authored card may omit them
 * while a parsed one carries them. They are then run through the app's own
 * `validateGridCards`, so a fixture that no longer matches the union is
 * dropped and warned about exactly like a bad card off the wire, rather than
 * throwing on import and taking the whole page down.
 */
type CardInput = z.input<typeof gridCardSchema>

const OIB2 = { document: 'OIB-Richtlinie 2', section: 'Pkt. 3.1', edition: 'Ausgabe Mai 2023' }
const OIB3 = { document: 'OIB-Richtlinie 3', section: 'Pkt. 9.1.1', edition: 'Ausgabe Mai 2023' }
const OIB4 = { document: 'OIB-Richtlinie 4', section: 'Pkt. 2.2', edition: 'Ausgabe Mai 2023' }
const OIB6 = { document: 'OIB-Richtlinie 6', section: 'Pkt. 4.2', edition: 'Ausgabe Mai 2023' }

/**
 * Card types the gallery describes but does not render, with the reason. Each
 * one needs data the gallery has no honest way to invent: the four IFC cards
 * carry GlobalIds resolved against a loaded model, and `document_grid` resolves
 * file names to real document rows. A fabricated preview of either would show a
 * platform owner a building that does not exist.
 */
export const PREVIEW_EXCLUDED: Record<string, 'needsModel' | 'needsDocuments'> = {
  ifc_viewer: 'needsModel',
  ifc_compliance: 'needsModel',
  ifc_schedule: 'needsModel',
  ifc_element: 'needsModel',
  ifc_diff: 'needsModel',
  // The picker lists the project's real models from the live list — a gallery
  // with no project has none to draw, the same reason the other IFC cards are
  // here.
  ifc_model_picker: 'needsModel',
  document_grid: 'needsDocuments',
}

/** One sample card per renderable type, in authoring (schema-input) shape. */
const RAW_FIXTURES: CardInput[] = [
  {
    type: 'summary',
    title: 'Gebäudeklasse 4 – Anforderungen im Überblick',
    content:
      'Für Ihr Wohngebäude mit Fluchtniveau 9,8 m gilt Gebäudeklasse 4. Daraus folgen erhöhte Anforderungen an Brandschutz und Erschließung.',
    key_points: [
      'Fluchtniveau 9,8 m → GK 4 (Grenze: 11 m)',
      'Treppenhaus als gesicherter Fluchtbereich erforderlich',
      'Barrierefreier Aufzug ab 3 oberirdischen Geschossen',
    ],
  },
  {
    type: 'legal_basis',
    law: 'OIB-Richtlinie 2',
    article: '3.1.1',
    section: 'Tabelle 1a',
    summary: 'Die maximale Brandabschnittsfläche für oberirdische Geschosse in GK 4 beträgt 1.200 m².',
    original_text:
      'Brandabschnitte dürfen eine Nettogrundfläche von höchstens 1.200 m² und eine Längenausdehnung von höchstens 60 m aufweisen.',
  },
  {
    type: 'requirement_checklist',
    title: 'Anforderungen GK 4 – Brandschutz',
    items: [
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
      { label: 'Zweiter Fluchtweg oder Anleiterbarkeit', status: 'needs_input' },
    ],
    reference: { document: 'OIB-Richtlinie 2', edition: 'Ausgabe Mai 2023' },
  },
  {
    type: 'comparison_table',
    title: 'GK 4 vs. GK 5 – wesentliche Anforderungen',
    options: ['GK 4', 'GK 5'],
    rows: [
      { label: 'Fluchtniveau', values: ['≤ 11 m', '≤ 22 m'], highlight_index: 0 },
      { label: 'Tragende Bauteile', values: ['REI 60', 'REI 90'], highlight_index: 0 },
      { label: 'Aufzug erforderlich', values: ['ab 3 Geschossen', 'ja'], highlight_index: 0 },
    ],
    recommendation: 'Mit Fluchtniveau 9,8 m bleibt das Projekt in GK 4.',
    reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', edition: 'Ausgabe Mai 2023' },
  },
  {
    type: 'verdict_header',
    verdict: '1,10 m',
    subject: 'Erforderliche Geländerhöhe',
    reference: OIB4,
    confidence: 'high',
  },
  {
    type: 'condition_tree',
    title: 'Erforderliche Feuerwiderstandsklasse tragender Bauteile',
    question: 'Gebäudeklasse',
    branches: [
      { condition: 'GK 1–3', outcome: 'REI 30 (bzw. R 30)' },
      { condition: 'GK 4', outcome: 'REI 60', active: true },
      {
        condition: 'GK 5',
        outcome: 'REI 90',
        reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
      },
    ],
    reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', edition: 'Ausgabe Mai 2023' },
  },
  {
    type: 'typed_table',
    title: 'Mindestmaße barrierefreie Erschließung',
    columns: [
      { label: 'Bauteil', type: 'text' },
      { label: 'Mindestmaß', type: 'mass' },
      { label: 'Grundlage', type: 'norm' },
      { label: 'Erfüllt', type: 'verdict' },
    ],
    rows: [
      ['Türdurchgangsbreite', '90 cm', 'ÖNORM B 1600 Pkt. 5.1', 'erfüllt'],
      ['Rampenneigung', '6 %', 'OIB-Richtlinie 4 Pkt. 3.2', 'nicht erfüllt'],
      ['Handlauf beidseitig', '—', 'ÖNORM B 1600 Pkt. 5.2', 'offen'],
    ],
    reference: { document: 'ÖNORM B 1600', edition: 'Ausgabe 2020' },
  },
  {
    type: 'norm_chain',
    title: 'Normenkette – Absturzsicherung',
    links: [
      { label: 'Wiener Bautechnikverordnung', rank: 'verordnung', note: 'erklärt die OIB-Richtlinien für verbindlich' },
      { label: 'OIB-Richtlinie 4', rank: 'oib_richtlinie', note: 'regelt die erforderliche Geländerhöhe' },
      { label: 'ÖNORM B 1600', rank: 'oenorm', note: 'konkretisiert die barrierefreie Ausführung' },
    ],
  },
  {
    type: 'project_profile_patch',
    title: 'Projektkontext aktualisieren: Fluchtniveau',
    rationale:
      'Sie haben angegeben, dass das oberste Fluchtniveau bei 25 m liegt — damit ist das Gebäude ein Hochhaus (> 22 m) und OIB-Richtlinie 2.3 wird anwendbar.',
    patch: [{ op: 'add', path: '/facts/fluchtniveau', value: '>22m' }],
    preview: [{ label: 'Fluchtniveau', before: '11–22 m', after: '> 22 m' }],
  },
  {
    type: 'memory_proposal',
    title: 'Diese Erkenntnis merken?',
    content: 'Das Büro setzt bei GK 4 durchgängig REI 90 an, auch wo REI 60 genügen würde.',
    kind: 'preference',
    confidence: 'high',
  },
  {
    type: 'building_section',
    title: 'Gebäudeschnitt – Höhenprüfung GK 4',
    storeys: [
      { label: 'KG', height_m: 2.5, below_grade: true },
      { label: 'EG', height_m: 3.2 },
      { label: '1.OG', height_m: 3.0 },
      { label: '2.OG', height_m: 3.0 },
      { label: '3.OG', height_m: 3.0 },
    ],
    markers: [
      { label: 'Fluchtniveau', height_m: 9.2, kind: 'fluchtniveau' },
      { label: 'GK4-Grenze', height_m: 11, kind: 'threshold' },
    ],
    reference: OIB2,
  },
  {
    type: 'stair_diagram',
    title: 'Treppenlauf – Steigungsverhältnis',
    riser_count: 17,
    // Measured off the model rather than typed by the user, so the gallery
    // shows the state that actually reaches a reviewer: our number, our band,
    // and „gemessen" beside it — never mistakable for the architect's own.
    riser_height: {
      label: 'Steigung',
      value: 17.6,
      required: 18,
      unit: 'cm',
      comparator: '<=',
      status: 'pass',
      provenance: 'computed',
      tolerance: 0.5,
    },
    tread_depth: {
      label: 'Auftritt',
      value: 28,
      required: 28,
      unit: 'cm',
      comparator: '>=',
      status: 'warning',
      provenance: 'computed',
      tolerance: 0.5,
      // Exactly on the limit with a 5 mm band: the honest state, and the one
      // the old card drew as a clean pass.
    },
    width: { label: 'Nutzbare Laufbreite', value: 110, required: 120, unit: 'cm', comparator: '>=', status: 'fail' },
    comfort_note: 'Schrittmaß 2×17,6 + 28 = 63,2 cm — innerhalb der Komfortregel (59–65 cm).',
    reference: OIB4,
  },
  {
    type: 'dimension_diagram',
    title: 'Rampe – Neigung & Breite',
    shape: 'ramp',
    dimensions: [
      { label: 'Neigung', value: 7.2, required: 6, unit: '%', comparator: '<=', status: 'fail', provenance: 'computed', tolerance: 0.1 },
      { label: 'nutzbare Breite', value: 120, required: 120, unit: 'cm', comparator: '>=', status: 'pass', provenance: 'declared' },
      // The third state, which the gallery had no example of at all: the export
      // cannot answer, and the card says what to change rather than showing a
      // blank the reader takes for a fact about the building.
      {
        label: 'Handlauf beidseitig',
        value: null,
        unit: 'cm',
        status: 'needs_input',
        missing: 'Dieser Export enthält kein IfcRailing — Handläufe im CAD als IfcRailing modellieren.',
      },
    ],
    reference: { document: 'ÖNORM B 1600', section: 'Pkt. 5.2' },
  },
  {
    type: 'setback_plan',
    title: 'Abstandsflächen – Lageplan',
    parcel_width_m: 22,
    parcel_depth_m: 30,
    building_width_m: 12,
    building_depth_m: 14,
    sides: [
      { side: 'left', required_m: 3, actual_m: 2.4, status: 'fail' },
      { side: 'right', required_m: 3, actual_m: 4.2, status: 'pass' },
      { side: 'front', required_m: 5, actual_m: 6.0, status: 'pass' },
      { side: 'back', required_m: 3, actual_m: null, status: 'needs_input' },
    ],
    reference: { document: 'NÖ Bauordnung 2014', section: '§ 54' },
  },
  {
    type: 'egress_diagram',
    title: 'Fluchtweg – Gehweglänge',
    segments: [
      { label: 'Raum → Gang', length_m: 12, turn: 'right' },
      { label: 'Gang', length_m: 18, turn: 'left' },
      { label: 'Gang → Treppenhaus', length_m: 8, turn: 'straight' },
    ],
    total_length: {
      label: 'Gehweglänge gesamt',
      value: 38,
      required: 40,
      unit: 'm',
      comparator: '<=',
      status: 'pass',
    },
    reference: OIB2,
  },
  {
    type: 'daylight_incidence',
    title: 'Belichtung – freier Lichteinfall',
    room_floor_area_m2: 22,
    glass_area: {
      label: 'Lichteintrittsfläche',
      value: 2.6,
      required: 2.2,
      unit: 'm²',
      comparator: '>=',
      status: 'pass',
    },
    window_sill_height_m: 1.0,
    window_head_height_m: 2.4,
    obstruction: { distance_m: 6, height_m: 7.5, label: 'Gegenüberliegendes Gebäude' },
    reference: OIB3,
  },
  {
    type: 'guardrail_check',
    title: 'Absturzsicherung Dachterrasse',
    context: 'dachterrasse',
    fall_height: { label: 'Absturzhöhe', value: 13.5, required: 12, unit: 'm', comparator: '<=', status: 'warning' },
    rail_height: { label: 'Geländerhöhe', value: 100, required: 110, unit: 'cm', comparator: '>=', status: 'fail' },
    max_opening: { label: 'max. Öffnungsweite', value: 11, required: 12, unit: 'cm', comparator: '<=', status: 'pass' },
    bottom_gap: { label: 'Bodenspalt', value: 3, required: 12, unit: 'cm', comparator: '<=', status: 'pass' },
    has_horizontal_elements_in_climb_zone: false,
    reference: OIB4,
  },
  {
    type: 'density_check',
    title: 'Bebauungsdichte – Grundstück',
    parcel_area_m2: 800,
    footprint_area_m2: 210,
    gross_floor_area_m2: 620,
    coverage: { label: 'Bebauungsgrad', value: 26.3, required: 30, unit: '%', comparator: '<=', status: 'pass' },
    density: { label: 'GFZ', value: null, required: 0.8, unit: '', comparator: '<=', status: 'needs_input' },
    reference: { document: 'Bebauungsplan Mustergemeinde' },
  },
  {
    type: 'fire_access_plan',
    title: 'Feuerwehrzufahrt & Aufstellfläche',
    parcel_width_m: 28,
    parcel_depth_m: 36,
    building_width_m: 16,
    building_depth_m: 14,
    route_width: { label: 'Zufahrt Breite', value: 3.5, required: 3, unit: 'm', comparator: '>=', status: 'pass' },
    gate_clearance_height: {
      label: 'Durchfahrt lichte Höhe',
      value: 4.0,
      required: 4.0,
      unit: 'm',
      comparator: '>=',
      status: 'pass',
    },
    aufstellflaeche: {
      width: { label: 'Breite', value: 5, required: 5, unit: 'm', comparator: '>=', status: 'pass' },
      length: { label: 'Länge', value: 11, required: 10, unit: 'm', comparator: '>=', status: 'pass' },
      distance_to_facade: {
        label: 'Abstand zur Fassade',
        value: 3,
        required: 10,
        unit: 'm',
        comparator: '<=',
        status: 'pass',
      },
    },
    walk_distance_to_entrance: {
      label: 'Weg zum Eingang',
      value: 34,
      required: 80,
      unit: 'm',
      comparator: '<=',
      status: 'pass',
    },
    gebaeudeklasse: 'GK 4',
    reference: { document: 'TRVB F 134', section: 'Pkt. 4' },
  },
  {
    type: 'acoustic_check',
    title: 'Schallschutz – Wohnungstrennung',
    checks: [
      {
        path_label: 'Wohnungstrennwand Top 3 / Top 4',
        metric: 'DnTw',
        check: { label: 'DnT,w', value: 56, required: 55, unit: 'dB', comparator: '>=', status: 'pass' },
        reference: { document: 'OIB-Richtlinie 5', section: 'Tabelle 1' },
      },
      {
        path_label: 'Außenwand Straßenseite',
        metric: 'Rw_res',
        check: { label: 'Rw,res', value: 40, required: 43, unit: 'dB', comparator: '>=', status: 'fail' },
        reference: { document: 'ÖNORM B 8115-2', section: 'Tabelle 2' },
      },
    ],
    sound_class: 'B',
  },
  {
    type: 'fire_compartment',
    title: 'Brandabschnitte – Regelgeschoss',
    storey_label: '2.OG',
    gebaeudeklasse: 'GK 4',
    compartments: [
      {
        label: 'BA 1',
        use: 'Wohnen',
        area: { label: 'BA 1', value: 980, required: 1200, unit: 'm²', comparator: '<=', status: 'pass' },
      },
      {
        label: 'BA 2',
        use: 'Büro',
        area: { label: 'BA 2', value: 1350, required: 1200, unit: 'm²', comparator: '<=', status: 'fail' },
      },
    ],
    reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1a', edition: 'Ausgabe Mai 2023' },
  },
  {
    type: 'thermal_envelope',
    title: 'Wärmeschutz – U-Werte der Gebäudehülle',
    components: [
      {
        label: 'Außenwand',
        kind: 'wall',
        u_value: {
          label: 'Außenwand',
          value: 0.28,
          required: 0.35,
          unit: 'W/(m²K)',
          comparator: '<=',
          status: 'pass',
        },
      },
      {
        label: 'Dach',
        kind: 'roof',
        u_value: { label: 'Dach', value: 0.22, required: 0.2, unit: 'W/(m²K)', comparator: '<=', status: 'fail' },
      },
      {
        label: 'Kellerdecke',
        kind: 'floor',
        u_value: {
          label: 'Kellerdecke',
          value: null,
          required: 0.4,
          unit: 'W/(m²K)',
          comparator: '<=',
          status: 'needs_input',
        },
      },
    ],
    reference: OIB6,
  },
  {
    type: 'energy_performance',
    title: 'Energieausweis – Heizwärmebedarf',
    hwb: {
      label: 'Heizwärmebedarf (HWB)',
      value: 42,
      required: 54.4,
      unit: 'kWh/m²a',
      comparator: '<=',
      status: 'pass',
    },
    energy_class: 'B',
    fgee: { label: 'fGEE', value: 0.82, required: 0.9, unit: '', comparator: '<=', status: 'pass' },
    reference: OIB6,
  },
  {
    type: 'elevator_requirement',
    title: 'Barrierefreier Aufzug – Erschließung',
    storeys_served: 5,
    entrance_level_index: 0,
    is_required: true,
    requirement_note: 'Mehr als 2 oberirdische Geschosse: ein barrierefreier Aufzug ist erforderlich.',
    cabin_width: { label: 'Kabinenbreite', value: 110, required: 110, unit: 'cm', comparator: '>=', status: 'pass' },
    cabin_depth: { label: 'Kabinentiefe', value: 140, required: 140, unit: 'cm', comparator: '>=', status: 'pass' },
    door_width: { label: 'lichte Türbreite', value: 80, required: 90, unit: 'cm', comparator: '>=', status: 'fail' },
    reference: { document: 'OIB-Richtlinie 4', section: 'Pkt. 2.5' },
  },
  {
    type: 'parking_requirement',
    title: 'Stellplatznachweis – Wohnbau',
    car_spaces: { label: 'Kfz-Stellplätze', value: 12, required: 14, unit: 'Stpl.', comparator: '>=', status: 'fail' },
    bicycle_spaces: {
      label: 'Fahrradabstellplätze',
      value: 28,
      required: 24,
      unit: 'Stpl.',
      comparator: '>=',
      status: 'pass',
    },
    basis: '1 Stellplatz je Wohneinheit (14 WE)',
    reference: { document: 'Wiener Garagengesetz 2008', section: '§ 48' },
  },
]

/**
 * The validated fixtures, keyed by card type. Anything the union no longer
 * accepts is absent here (and warned about by `validateGridCards`), so the
 * gallery degrades to "described but not previewed" instead of rendering a
 * card shape the agent could never emit.
 */
export const CARD_PREVIEW_FIXTURES: Partial<Record<GridCard['type'], GridCard>> = Object.fromEntries(
  validateGridCards(RAW_FIXTURES).map((card) => [card.type, card])
)

/** The sample card for a type, or `undefined` when the gallery cannot preview it. */
export function previewFixtureFor(type: string): GridCard | undefined {
  return CARD_PREVIEW_FIXTURES[type as GridCard['type']]
}
