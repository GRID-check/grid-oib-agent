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

/**
 * The statute half of the `legal_basis` pair.
 *
 * `CARD_PREVIEW_FIXTURES` is keyed by card type, so it can hold exactly one
 * `legal_basis` — and one is not enough for the card whose whole point is which
 * tier of Baurecht it cites. A Gesetz keeps the law blue and the RIS badge, an
 * OIB-Richtlinie takes the indigo accent and the OIB badge, and neither is
 * derived from the law name: both come off `lane`. Rendered next to the fixture
 * on `/dev/cards`, which is where the two are compared.
 */
export const LEGAL_BASIS_STATUTE: CardInput = {
  type: 'legal_basis',
  law: 'Wiener Bauordnung',
  lane: 'baurecht_ris',
  // A Gesetz has a Fassung, not an Ausgabe — the honest value here is none, and
  // the card renders without it rather than inventing one.
  article: '87',
  section: 'Abs. 4',
  summary:
    'Bauliche Anlagen sind so zu errichten, dass die Standsicherheit und der Brandschutz während der gesamten Nutzungsdauer gewährleistet sind.',
  original_text:
    'Bauwerke müssen so geplant und ausgeführt werden, dass sie den zu erwartenden Einwirkungen standhalten.',
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
  // The OIB tier: `lane` paints the indigo accent and the OIB badge, and the
  // Ausgabe is what makes the citation checkable rather than merely named. Its
  // statute counterpart is `LEGAL_BASIS_STATUTE` below — the map is keyed by
  // type, so only one of the two can be the gallery's fixture; the pair exists
  // so the difference the lane makes can be seen side by side.
  {
    type: 'legal_basis',
    law: 'OIB-Richtlinie 2',
    lane: 'baurecht_oib',
    edition: 'Ausgabe Mai 2023',
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
    // Carries a takeaway WITHOUT a detail on purpose: the gallery should show
    // that a row only becomes an expander when there is something behind it.
    type: 'key_takeaways',
    title: 'Gebäudeklasse 4 – was daraus folgt',
    items: [
      {
        text: 'Fluchtniveau 9,80 m → Gebäudeklasse 4',
        detail: 'Maßgeblich ist das oberste Fluchtniveau; die Grenze zu GK 5 liegt bei 11 m.',
      },
      {
        text: 'Tragende Bauteile mindestens REI 60',
        detail: 'In Kellergeschossen gilt REI 90, unabhängig von der Gebäudeklasse.',
      },
      { text: 'Barrierefreier Aufzug ab drei oberirdischen Geschossen' },
    ],
  },
  {
    type: 'callout',
    kind: 'frist',
    title: 'Nur in Wien',
    text: 'Die Bauverhandlung ist binnen sechs Wochen nach Einreichung anzuberaumen.',
    detail: 'Die Frist ruht, solange die Behörde eine Ergänzung des Einreichplans verlangt hat.',
  },
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
    type: 'process_map',
    title: 'Baubewilligungsverfahren – Wien',
    current_step: 2,
    steps: [
      {
        label: 'Einreichung',
        summary: 'Einreichunterlagen werden bei der Baubehörde eingebracht.',
        actor: 'Bauwerber',
        requires: ['Einreichplan', 'Baubeschreibung', 'Energieausweis'],
        produces: ['Aktenzeichen'],
        reference: { document: 'Wiener Bauordnung', section: '§ 63' },
      },
      {
        label: 'Bauverhandlung',
        summary: 'Mündliche Verhandlung mit Nachbarn und Amtssachverständigen.',
        actor: 'Baubehörde',
        duration: 'binnen sechs Wochen',
        produces: ['Verhandlungsschrift'],
        reference: { document: 'Wiener Bauordnung', section: '§ 70' },
      },
      {
        label: 'Baubewilligung',
        summary: 'Bescheid mit den Auflagen aus der Verhandlung.',
        actor: 'Baubehörde',
        produces: ['Baubewilligungsbescheid'],
      },
      {
        label: 'Baubeginnsanzeige',
        summary: 'Der Baubeginn ist der Behörde anzuzeigen.',
        actor: 'Bauwerber',
        requires: ['rechtskräftige Baubewilligung'],
      },
      {
        label: 'Fertigstellungsanzeige',
        summary: 'Nach Fertigstellung, mit den Ausführungsbestätigungen.',
        actor: 'Bauwerber',
        requires: ['Ausführungsbestätigungen der Fachplaner'],
      },
    ],
    reference: { document: 'Wiener Bauordnung', section: '§§ 60 ff.' },
  },
  {
    // Carries the HARD state a platform owner has to see: two documents the
    // conversation settled (one held, one still to obtain), three it did not,
    // and two that are conditional with the case spelled out. The tally under
    // the title counts all of that itself — including the „ungeklärt" three,
    // which a progress bar would have quietly folded into „not done".
    type: 'document_checklist',
    title: 'Einreichunterlagen – Neubau Wohngebäude, Wien',
    items: [
      {
        label: 'Einreichplan',
        requirement: 'required',
        issuer: 'Ziviltechniker:in',
        status: 'present',
        note: 'dreifach, im Maßstab 1:100',
        reference: { document: 'Wiener Bauordnung', section: '§ 63 Abs. 1 lit. a' },
      },
      {
        label: 'Baubeschreibung',
        requirement: 'required',
        issuer: 'Ziviltechniker:in',
        reference: { document: 'Wiener Bauordnung', section: '§ 63 Abs. 1 lit. b' },
      },
      {
        label: 'Energieausweis',
        requirement: 'required',
        issuer: 'befugte Fachperson',
        status: 'missing',
        reference: OIB6,
      },
      {
        label: 'Grundbuchsauszug',
        requirement: 'conditional',
        condition: 'nur wenn der Bauwerber nicht Eigentümer der Liegenschaft ist',
        issuer: 'Bauwerber',
      },
      {
        label: 'Gutachten der MA 19',
        requirement: 'conditional',
        condition: 'nur bei einem Gebäude in einer Schutzzone',
        issuer: 'Baubehörde',
      },
    ],
    reference: { document: 'Wiener Bauordnung', section: '§ 63' },
  },
  {
    // Three clocks running from three different events, which is the reason
    // this is not three callouts. Every period is the Bestimmung's wording and
    // none of them is a date — the backend rejects one, and the gallery should
    // show what the card looks like when that rule is kept.
    type: 'deadline_timeline',
    title: 'Fristen im Bauverfahren – Wien',
    deadlines: [
      {
        label: 'Beschwerdefrist',
        period: 'binnen vier Wochen',
        starts_from: 'ab Zustellung des Baubewilligungsbescheids',
        actor: 'Nachbar oder Bauwerber',
        consequence: 'Der Bescheid wird rechtskräftig.',
        reference: { document: 'VwGVG', section: '§ 7 Abs. 4' },
      },
      {
        label: 'Geltungsdauer der Baubewilligung',
        period: 'binnen vier Jahren ist mit dem Bau zu beginnen',
        starts_from: 'ab Rechtskraft der Baubewilligung',
        actor: 'Bauwerber',
        consequence: 'Die Baubewilligung erlischt.',
        reference: { document: 'Wiener Bauordnung', section: '§ 74 Abs. 1' },
      },
      {
        label: 'Fertigstellungsanzeige',
        period: 'unverzüglich',
        starts_from: 'ab Fertigstellung des Bauvorhabens',
        actor: 'Bauwerber',
        reference: { document: 'Wiener Bauordnung', section: '§ 128' },
      },
    ],
  },
  {
    // One row is `unchanged`, one carries no `before` — the two states a
    // uniformly „everything gets stricter" fixture would hide, and both are
    // states a reader has to be able to recognise at a glance.
    type: 'change_impact',
    title: 'Fluchtniveau über 11 m – was sich ändert',
    factor: 'Fluchtniveau',
    from_value: '7 bis 11 m',
    to_value: 'über 11 m',
    consequences: [
      {
        aspect: 'Gebäudeklasse',
        before: 'GK 4',
        after: 'GK 5',
        direction: 'tightens',
        reference: { document: 'OIB-Begriffsbestimmungen', section: 'Gebäudeklassen' },
      },
      {
        aspect: 'Feuerwiderstand tragender Bauteile',
        before: 'R 60',
        after: 'R 90',
        direction: 'tightens',
        detail: 'Die Anforderung gilt für die tragenden Bauteile der oberirdischen Geschoße.',
        reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1', edition: 'Ausgabe Mai 2023' },
      },
      {
        aspect: 'Aufzug',
        after: 'Aufzug erforderlich',
        direction: 'tightens',
        reference: OIB4,
      },
      {
        aspect: 'Schallschutz zwischen den Wohnungen',
        before: 'DnT,w mindestens 55 dB',
        after: 'DnT,w mindestens 55 dB',
        direction: 'unchanged',
        detail: 'Der Schallschutz hängt an der Nutzung, nicht an der Gebäudeklasse.',
        reference: { document: 'OIB-Richtlinie 5', section: 'Tabelle 1', edition: 'Ausgabe Mai 2023' },
      },
    ],
    reference: { document: 'OIB-Begriffsbestimmungen', section: 'Gebäudeklassen' },
  },
  {
    // One chip without a `hint` on purpose: the tooltip is an extra, and the
    // gallery should not suggest that a follow-up is incomplete without one.
    type: 'follow_ups',
    items: [
      { question: 'Wie wird das Fluchtniveau genau gemessen?', hint: 'Messpunkt und Bezugsebene' },
      { question: 'Welche Anforderungen gelten für mein Projekt konkret?' },
      { question: 'Was wäre bei Gebäudeklasse 5 anders?', hint: 'Vergleich der beiden Klassen' },
    ],
  },
  {
    // `CARD_EXAMPLES['diagram']` in `src/aiq_agent/cards/catalog.py`, which is
    // the shape the MODEL is shown — so the gallery photographs the card the
    // agent was actually taught to emit rather than a prettier one.
    //
    // A `sequence` and not a flowchart on purpose: it is the grammar whose
    // rendered SVG carries the most that must survive the pipeline (an actor
    // icon library in the `<defs>`, dashed return arrows), so a gallery shot of
    // it is the one that shows a mermaid upgrade breaking the drawing. Note
    // what it does NOT carry — no Frist, no duration, no measurement — because
    // this is the card for the drawings that make no dimensional claim.
    type: 'diagram',
    title: 'Baubewilligungsverfahren – wer wem was übergibt',
    diagram_type: 'sequence',
    source: [
      'sequenceDiagram',
      '  participant BW as Bauwerber',
      '  participant BB as Baubehörde',
      '  participant ASV as Amtssachverständige',
      '  BW->>BB: Einreichunterlagen',
      '  BB->>ASV: Befassung zur Begutachtung',
      '  ASV-->>BB: Gutachten',
      '  BB-->>BW: Verbesserungsauftrag',
      '  BW->>BB: ergänzte Unterlagen',
      '  BB-->>BW: Baubewilligungsbescheid',
    ].join('\n'),
    caption: 'Die Fristen zeigt die Grafik nicht — sie steht für die Reihenfolge der Übergaben.',
    reference: { document: 'Wiener Bauordnung', section: '§§ 60 ff.' },
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
  validateGridCards(RAW_FIXTURES).flatMap((card) => (card ? [[card.type, card] as const] : []))
)

/** The sample card for a type, or `undefined` when the gallery cannot preview it. */
export function previewFixtureFor(type: string): GridCard | undefined {
  return CARD_PREVIEW_FIXTURES[type as GridCard['type']]
}
