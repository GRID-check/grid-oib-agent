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
    // Carries a MEASURED operand with its band, because that is the hard state:
    // the result the card computes is 64,0 cm ±1,0, which sits inside the
    // Schrittmaßregel's 59–65 cm at every point of the band. The gallery reader
    // should see that the card decided that itself.
    type: 'calculation',
    title: 'Schrittmaßregel – Treppenlauf Haus A',
    steps: [
      {
        label: 'Schrittmaß',
        operation: 'sum',
        unit: 'cm',
        operands: [
          {
            label: 'Steigung',
            value: 17,
            unit: 'cm',
            factor: 2,
            provenance: 'computed',
            tolerance: 0.5,
            source: 'Einreichplan, Schnitt A-A',
          },
          { label: 'Auftritt', value: 30, unit: 'cm', provenance: 'declared' },
        ],
      },
    ],
    limit: {
      comparator: 'between',
      value: 59,
      upper: 65,
      label: 'Schrittmaßregel',
      reference: OIB4,
    },
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
    // The state a draft is usually met in: written more than once, because the
    // reader asked for a change and the tool edited the same path again, and
    // not yet filed — so the card offers to ASK Piloti to file it rather than
    // claiming a project document that does not exist.
    type: 'document_draft',
    title: 'Aktenvermerk – Abweichung Fluchtweglänge',
    path: '/entwuerfe/aktenvermerk-fluchtweg.md',
    bytes: 4820,
    version: 3,
  },
  {
    // The same draft after `file_draft`: it names a project document and an
    // open version, which is what turns the card's two controls on.
    type: 'document_draft',
    title: 'Aktenvermerk – Abweichung Fluchtweglänge',
    path: '/entwuerfe/aktenvermerk-fluchtweg.md',
    bytes: 4820,
    version: 3,
    document_id: '00000000-0000-4000-8000-000000000001',
    version_id: '00000000-0000-4000-8000-0000000000a1',
    version_state: 'draft',
  },
  {
    // Delegation, in the shape it is usually met in: a deadline the person named
    // and a thread the run is writing into, because those are the two facts the
    // card can offer beyond „angelegt".
    type: 'task_created',
    task_id: '00000000-0000-4000-8000-0000000000f1',
    kind: 'einreichcheck',
    title: 'Einreichcheck: Bauansuchen Haus A',
    goal: 'Mach den Einreichcheck für das Bauansuchen bis Freitag',
    due_at: '2026-09-18T23:59:59.999Z',
    conversation_id: 's_00000000_0000_4000_8000_0000000000f2',
  },
  {
    // The state the card is usually met in: a tidying turn that proposed more
    // than one move, so the batch and the „from → to" row both have to render.
    type: 'file_operation_proposal',
    title: 'Drei Dateien in „Einreichung/Pläne“ verschieben',
    operation: 'move',
    operations: [
      {
        document: 'Grundriss EG.pdf',
        source: 'projekt',
        current: 'Nachweise',
        target_folder: 'Einreichung/Pläne',
      },
      {
        document: 'Grundriss OG.pdf',
        source: 'projekt',
        current: '',
        target_folder: 'Einreichung/Pläne',
      },
      {
        document: 'Schnitt A-A.pdf',
        source: 'projekt',
        current: 'Nachweise',
        target_folder: 'Einreichung/Pläne',
      },
    ],
    note: 'Vorschlag — es wurde noch nichts verschoben.',
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
      // Exactly on the limit with a 5 mm band: the honest state, and not a
      // clean pass.
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
      // The third state: the export cannot answer, and the card says what to
      // change rather than showing a blank the reader takes for a fact about
      // the building.
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
  // A composition (ADR-0065): two variants of one question as tabs, each a
  // run of Markdown. Values show the form, not the Richtlinie.
  {
    type: 'surface',
    title: 'Zweiter Fluchtweg — zwei Varianten',
    components: [
      {
        id: 'root',
        component: 'Tabs',
        tabs: [
          { title: 'Außentreppe', child: 'aussen' },
          { title: 'Zweites Treppenhaus', child: 'treppenhaus' },
        ],
      },
      {
        id: 'aussen',
        component: 'Text',
        text: [
          '1. **Lage klären**: Abstand zu Fenstern und Öffnungen prüfen.',
          '2. **Brandschutzkonzept ergänzen**: Außentreppe als Fluchtweg nachweisen.',
          '3. **Einreichung** mit dem Bauansuchen.',
        ].join('\n'),
      },
      {
        id: 'treppenhaus',
        component: 'Text',
        text: [
          '1. **Grundriss anpassen**: zweites Treppenhaus im Gebäudekern.',
          '2. **Fluchtweglängen neu messen**: Längen zu beiden Treppenhäusern.',
          '3. **Einreichung** mit dem Bauansuchen.',
        ].join('\n'),
      },
    ],
  },
]

/**
 * The validated fixtures, keyed by card type. Anything the union no longer
 * accepts is absent here (and warned about by `validateGridCards`), so the
 * gallery degrades to "described but not previewed" instead of rendering a
 * card shape the agent could never emit.
 */
export const CARD_PREVIEW_FIXTURES: Partial<Record<GridCard['type'], GridCard>> = Object.fromEntries(
  validateGridCards(RAW_FIXTURES).flatMap((card) => (card ? [[card.type, card] as const] : []))
)

/** The sample card for a type, or `undefined` when the gallery cannot preview it. */
export function previewFixtureFor(type: string): GridCard | undefined {
  return CARD_PREVIEW_FIXTURES[type as GridCard['type']]
}
