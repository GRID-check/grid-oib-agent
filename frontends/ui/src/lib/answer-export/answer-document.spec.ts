/**
 * @vitest-environment node
 */
/**
 * What the exported document says, and — more importantly — what it refuses to
 * say.
 *
 * The document is asserted at the BLOCK level rather than by unzipping a .docx,
 * because the two questions are different: `docx.spec.ts` asks whether Word can
 * open the package, this file asks whether the package tells the truth. Those
 * are the failures that matter here, in the order they would hurt:
 *
 *   1. citations arriving as bare `[3]` markers with no reference list — the
 *      defect this whole feature exists to fix;
 *   2. a card silently missing, which reads as an answer that never made that
 *      finding;
 *   3. a placeholder standing in for a field the answer does not have, which is
 *      the export inventing content;
 *   4. a hardcoded German heading in an English document (or the reverse).
 *
 * The translators are the REAL dictionaries. A spec with a stub translator
 * would pass with every key missing, which is precisely the bug the last
 * assertion in this file is here to catch.
 */

import { describe, expect, it } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { de, en } from '@/i18n/dictionaries'
import type { DocBlock } from './blocks'
import { buildAnswerDocument, type AnswerDocumentInput } from './answer-document'
import { gridCardSchema } from '@/shared/cards/schemas'
import { previewFixtureFor } from '@/features/grid-cards/preview-fixtures'

const german = createTranslator(de, 'answerExport')
const english = createTranslator(en, 'answerExport')

const CREATED_AT = new Date('2026-05-04T09:30:00Z')

/** Flatten blocks to text so a spec can assert on what a reader would see. */
const text = (blocks: DocBlock[]): string =>
  blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
          return block.text
        case 'paragraph':
          return block.runs.map((run) => run.text).join('')
        case 'bullets':
          return block.items.map((item) => item.map((run) => run.text).join('')).join('\n')
        case 'table':
          return [
            (block.head ?? []).join(' | '),
            ...block.rows.map((row) =>
              row.map((cell) => cell.map((run) => run.text).join('')).join(' | ')
            ),
          ]
            .filter(Boolean)
            .join('\n')
      }
    })
    .join('\n')

const input = (overrides: Partial<AnswerDocumentInput> = {}): AnswerDocumentInput => ({
  conversationTitle: 'Fluchtwege Bauteil B',
  projectName: 'Wohnhaus Seestadt',
  question: 'Wie lang darf der Fluchtweg in GK 4 sein?',
  answer: 'Die Gehweglänge darf **40 m** nicht überschreiten [1].',
  createdAt: CREATED_AT,
  ...overrides,
})

/** The stored citation payload, in the versioned wire shape the chat writes. */
const storedCitations = {
  v: 1,
  sources: [
    {
      citation_key: 'OIB-RL 2, Pkt. 5.1.1',
      title: 'OIB-Richtlinie 2 — Brandschutz',
      page: 18,
      number: 1,
      url: 'https://www.oib.or.at/rl2',
      content: 'Die Gehweglänge darf 40 m nicht überschreiten.',
    },
    // A second chunk of the SAME source, sharing its number: a reference list
    // wants the source once, not once per retrieved passage.
    { citation_key: 'OIB-RL 2, Pkt. 5.1.1', page: 19, number: 1 },
    // Retrieved but never cited — no number, so no `[N]` points at it.
    { title: 'ÖNORM B 1600', content: 'Barrierefreies Bauen' },
  ],
}

describe('the document’s chrome', () => {
  it('takes every heading from the dictionary, in the reader’s language', () => {
    const output = text(buildAnswerDocument(input(), german, 'de'))

    expect(output).toContain('Frage')
    expect(output).toContain('Antwort')
    expect(output).toContain('Projekt: Wohnhaus Seestadt')
    expect(output).toContain('Erstellt am: 4. Mai 2026')

    const english_ = text(buildAnswerDocument(input(), english, 'en'))
    expect(english_).toContain('Question')
    expect(english_).toContain('Project: Wohnhaus Seestadt')
    expect(english_).toContain('Created on: May 4, 2026')
  })

  it('titles the document with the conversation, and dates it from the ANSWER', () => {
    const blocks = buildAnswerDocument(input(), german, 'de')

    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'Fluchtwege Bauteil B' })
    // Not "today": an export stamped with the download time dates a year-old
    // finding to the day somebody happened to open it.
    expect(text(blocks)).toContain('4. Mai 2026')
  })

  it('renders the answer’s markdown as document structure, not as notation', () => {
    const blocks = buildAnswerDocument(
      input({ answer: '## Ergebnis\n\n- Erster Punkt\n- Zweiter Punkt' }),
      german,
      'de'
    )

    expect(blocks).toContainEqual({ kind: 'heading', level: 3, text: 'Ergebnis' })
    // The bullet glyph is added by the .docx renderer; the block model carries
    // the items, which is what a second output format would read.
    expect(text(blocks)).toContain('Erster Punkt')
    expect(text(blocks)).not.toContain('## Ergebnis')
  })
})

describe('citations', () => {
  it('renders the stored sources as a numbered reference list, not as raw markers', () => {
    const output = text(
      buildAnswerDocument(input({ citations: storedCitations }), german, 'de')
    )

    expect(output).toContain('Quellen')
    expect(output).toContain('[1] OIB-RL 2, Pkt. 5.1.1 — OIB-Richtlinie 2 — Brandschutz, S. 18')
    expect(output).toContain('https://www.oib.or.at/rl2')
    // The marker in the prose stays, because it is what points AT the list.
    expect(output).toContain('40 m nicht überschreiten [1]')
  })

  it('lists a source once even when several passages of it were retrieved', () => {
    const output = text(
      buildAnswerDocument(input({ citations: storedCitations }), german, 'de')
    )

    expect(output.match(/\[1\] OIB-RL 2/g)).toHaveLength(1)
    // Retrieved-but-not-cited stays out: nothing in the prose points at it, so
    // listing it would claim the answer rested on it.
    expect(output).not.toContain('ÖNORM B 1600')
  })

  it('keeps the numbers the prose used rather than renumbering the list', () => {
    const citations = {
      v: 1,
      sources: [
        { title: 'Zweite Quelle', number: 2 },
        { title: 'Dritte Quelle', number: 3 },
      ],
    }
    const output = text(
      buildAnswerDocument(
        input({ answer: 'Siehe [3] und [2].', citations }),
        german,
        'de'
      )
    )

    expect(output).toContain('[2] Zweite Quelle')
    expect(output).toContain('[3] Dritte Quelle')
    expect(output).not.toContain('[1]')
  })

  it('falls back to the sources the answer wrote into its own prose, and states them once', () => {
    const answer =
      'Die Gehweglänge darf 40 m nicht überschreiten [1].\n\n' +
      '## Quellen\n\n1. OIB-Richtlinie 2, Ausgabe 2023, S. 18\n'
    const output = text(buildAnswerDocument(input({ answer }), german, 'de'))

    expect(output).toContain('[1] OIB-Richtlinie 2, Ausgabe 2023, S. 18')
    // Lifted out of the prose: two lists of the same sources, with no guarantee
    // of agreeing, is worse than one.
    expect(output.match(/OIB-Richtlinie 2, Ausgabe 2023, S\. 18/g)).toHaveLength(1)
  })

  it('names an untitled source rather than leaving a blank line in the list', () => {
    const output = text(
      buildAnswerDocument(
        input({ citations: { v: 1, sources: [{ number: 1, content: 'irgendein Text' }] } }),
        german,
        'de'
      )
    )

    expect(output).toContain('[1] Quelle ohne Titel')
  })
})

describe('fields the stored answer does not have', () => {
  it('omits the project, the confidence and the sources rather than writing placeholders', () => {
    const output = text(
      buildAnswerDocument(
        input({ projectName: null, question: null, citations: undefined, confidence: null }),
        german,
        'de'
      )
    )

    expect(output).not.toContain('Projekt')
    expect(output).not.toContain('Frage')
    expect(output).not.toContain('Quellen')
    expect(output).not.toContain('Verlässlichkeit')
    // Nothing is left standing in for them.
    expect(output).not.toContain('—')
    expect(output).not.toContain('n/a')
  })

  it('treats a whitespace-only project name as no project at all', () => {
    const output = text(buildAnswerDocument(input({ projectName: '   ' }), german, 'de'))

    expect(output).not.toContain('Projekt')
  })

  it('falls back to the dictionary title when the conversation was never named', () => {
    const blocks = buildAnswerDocument(input({ conversationTitle: null }), german, 'de')

    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'Antwort' })
  })

  it('drops the answer section entirely when the stored prose is empty', () => {
    const output = text(buildAnswerDocument(input({ answer: '   ' }), german, 'de'))

    expect(output).not.toContain('Antwort\n')
    expect(output).toContain('Frage')
  })

  it('carries the confidence and its reason when the answer stored them', () => {
    const output = text(
      buildAnswerDocument(
        input({
          confidence: {
            level: 'medium',
            reason: 'Die Quelle nennt die Länge, nicht aber die Ausnahme.',
            cappedReason: 'quote_unverified',
          },
        }),
        german,
        'de'
      )
    )

    expect(output).toContain('Verlässlichkeit: mittel')
    expect(output).toContain('Begründung des Assistenten: Die Quelle nennt die Länge')
    expect(output).toContain('nicht wortgleich gegen die Quelle prüfbar')
  })
})

describe('cards', () => {
  const checklist = {
    type: 'requirement_checklist',
    title: 'Anforderungen GK 4 – Brandschutz',
    items: [
      {
        label: 'Zweiter Fluchtweg vorhanden',
        status: 'pass',
        detail: 'über den Balkon',
        reference: { document: 'OIB-Richtlinie 2', section: 'Pkt. 5.1.1' },
      },
      { label: 'Brandabschnitt ≤ 1.200 m²', status: 'needs_input' },
    ],
    reference: { document: 'OIB-Richtlinie 2', edition: 'Ausgabe Mai 2023' },
    note: null,
  }

  it('renders a checklist card as a titled table with translated verdicts', () => {
    const blocks = buildAnswerDocument(input({ cards: [checklist] }), german, 'de')
    const output = text(blocks)

    expect(output).toContain('Befunde')
    expect(output).toContain('Anforderungen GK 4 – Brandschutz')
    expect(output).toContain('Position | Beurteilung | Detail | Fundstelle')
    expect(output).toContain('Zweiter Fluchtweg vorhanden | Anforderung erfüllt | über den Balkon')
    expect(output).toContain('Angabe erforderlich')
    // The card's own overall Fundstelle, on its own line.
    expect(output).toContain('OIB-Richtlinie 2, Ausgabe Mai 2023')
    // A table is a table — a card must not arrive as a JSON blob.
    expect(output).not.toContain('{')
    expect(blocks.some((block) => block.kind === 'table')).toBe(true)
  })

  it('renders a measured value with the qualifiers that say who is claiming it', () => {
    const stair = {
      type: 'stair_diagram',
      title: 'Treppenlauf',
      riser_count: 17,
      riser_height: {
        label: 'Steigung',
        value: 18.2,
        required: 18,
        unit: 'cm',
        comparator: '<=',
        status: 'fail',
        provenance: 'computed',
        tolerance: 0.5,
      },
      reference: { document: 'OIB-Richtlinie 4' },
    }
    const output = text(buildAnswerDocument(input({ cards: [stair] }), german, 'de'))

    expect(output).toContain('Position | Ist | Soll | Beurteilung')
    // The tolerance and "gemessen" ride along with the number: without them our
    // measurement reads as the architect's own declared figure.
    expect(output).toContain('Steigung | 18.2 ±0.5 cm (gemessen) | <= 18 cm | Anforderung nicht erfüllt')
  })

  it('states a live-data card instead of dropping it', () => {
    const output = text(
      buildAnswerDocument(
        input({ cards: [{ type: 'ifc_compliance', title: 'Anforderungen Brandschutz' }] }),
        german,
        'de'
      )
    )

    expect(output).toContain('Anforderungen Brandschutz')
    expect(output).toContain('liest das Modell des Projekts live')
  })

  it('titles a card that has no title of its own from its type', () => {
    const output = text(
      buildAnswerDocument(
        input({ cards: [{ type: 'legal_basis', law: 'OIB-Richtlinie 2', article: '§ 3' }] }),
        german,
        'de'
      )
    )

    expect(output).toContain('Rechtsgrundlage')
    expect(output).toContain('Gesetz / Richtlinie | OIB-Richtlinie 2')
  })
})

/**
 * The guard that keeps the document localized.
 *
 * `createTranslator` answers a missing key with the key itself, so a dictionary
 * gap does not throw — it ships `answerExport.fields.storeys` into a file an
 * architect forwards to a Behörde. One card of every type in the catalogue goes
 * through both locales, and any dot-path that survives is the failure.
 */
describe('every string in the document comes from a dictionary', () => {
  /**
   * Hand-written bodies, keyed by card type.
   *
   * Rich on purpose — the point is to push every field name and every enum
   * value through the dictionaries, which a minimal card would not. It is NOT
   * the list of card types: that comes off the union below, so a type nobody
   * wrote a body for still gets exported (from its gallery fixture) rather than
   * silently sitting this describe block out.
   */
  const authoredCards: Record<string, unknown>[] = [
    { type: 'summary', title: 'Kurzfassung', content: 'Kurz.', key_points: ['A', 'B'] },
    { type: 'legal_basis', law: 'OIB 2', article: '§ 3', section: 'Pkt. 5', summary: 'Kurz.', original_text: 'Wortlaut.' },
    {
      type: 'project_profile_patch',
      title: 'Projektkontext',
      rationale: 'Neu gelernt.',
      patch: [{ op: 'add', path: '/facts/gk', value: 'GK4' }],
      preview: [{ label: 'GK', before: '-', after: 'GK4' }],
    },
    { type: 'memory_proposal', title: 'Merken?', content: 'Fluchtniveau 9,8 m', kind: 'derived_fact', confidence: 'high' },
    { type: 'requirement_checklist', title: 'Liste', items: [{ label: 'A', status: 'pass' }] },
    {
      type: 'comparison_table',
      title: 'GK 4 vs GK 5',
      options: ['GK 4', 'GK 5'],
      rows: [{ label: 'Fläche', values: ['1200', '1600'], highlight_index: 0 }],
      recommendation: 'GK 4',
    },
    {
      type: 'building_section',
      title: 'Schnitt',
      storeys: [{ label: 'EG', height_m: 3, below_grade: false }],
      markers: [{ label: 'Fluchtniveau', height_m: 9.8, kind: 'fluchtniveau' }],
      reference: { document: 'OIB 2' },
    },
    {
      type: 'stair_diagram',
      title: 'Treppe',
      riser_count: 17,
      riser_height: { label: 'Steigung', value: 18, unit: 'cm', status: 'pass' },
      tread_depth: { label: 'Auftritt', value: 28, unit: 'cm', status: 'pass' },
      width: { label: 'Breite', value: 100, unit: 'cm', status: 'pass' },
      comfort_note: 'Schrittmaß erfüllt',
      reference: { document: 'OIB 4' },
    },
    {
      type: 'dimension_diagram',
      title: 'Rampe',
      shape: 'ramp',
      dimensions: [{ label: 'Neigung', value: 6, required: 10, unit: '%', status: 'pass' }],
      reference: { document: 'OIB 4' },
    },
    {
      type: 'setback_plan',
      title: 'Abstände',
      parcel_width_m: 20,
      parcel_depth_m: 30,
      building_width_m: 10,
      building_depth_m: 12,
      sides: [{ side: 'front', required_m: 3, actual_m: 4, status: 'pass' }],
      reference: { document: 'Bauordnung' },
    },
    {
      type: 'egress_diagram',
      title: 'Fluchtweg',
      start_label: 'ungünstigster Punkt',
      exit_label: 'Treppenhaus',
      segments: [{ label: 'Raum → Gang', length_m: 12, turn: 'left' }],
      total_length: { label: 'Gesamt', value: 38, required: 40, unit: 'm', status: 'pass' },
      reference: { document: 'OIB 2' },
    },
    {
      type: 'daylight_incidence',
      title: 'Belichtung',
      room_floor_area_m2: 24,
      window_sill_height_m: 0.9,
      window_head_height_m: 2.4,
      glass_area: { label: 'Lichteintritt', value: 3, required: 2.4, unit: 'm²', status: 'pass' },
      obstruction: { label: 'Nachbargebäude', distance_m: 8 },
      reference: { document: 'OIB 3' },
    },
    {
      type: 'guardrail_check',
      title: 'Geländer',
      context: 'balkon',
      fall_height: { label: 'Absturzhöhe', value: 8, unit: 'm', status: 'pass' },
      rail_height: { label: 'Höhe', value: 100, required: 100, unit: 'cm', status: 'pass' },
      max_opening: { label: 'Öffnung', value: 11, required: 12, unit: 'cm', status: 'pass' },
      bottom_gap: { label: 'Bodenabstand', value: 3, unit: 'cm', status: 'pass' },
      has_horizontal_elements_in_climb_zone: false,
      reference: { document: 'OIB 4' },
    },
    {
      type: 'density_check',
      title: 'Dichte',
      parcel_area_m2: 600,
      footprint_area_m2: 180,
      gross_floor_area_m2: 540,
      coverage: { label: 'Bebauungsgrad', value: 0.3, required: 0.4, unit: '', status: 'pass' },
      density: { label: 'GFZ', value: 0.9, required: 1.2, unit: '', status: 'pass' },
      reference: { document: 'Bebauungsplan' },
    },
    {
      type: 'fire_access_plan',
      title: 'Feuerwehrzufahrt',
      gebaeudeklasse: 'GK 4',
      parcel_width_m: 20,
      parcel_depth_m: 30,
      building_width_m: 10,
      building_depth_m: 12,
      route_width: { label: 'Zufahrt', value: 3.5, required: 3, unit: 'm', status: 'pass' },
      gate_clearance_height: { label: 'Durchfahrt', value: 4, required: 3.5, unit: 'm', status: 'pass' },
      aufstellflaeche: { label: 'Aufstellfläche', width_m: 5, length_m: 12 },
      walk_distance_to_entrance: { label: 'Weg', value: 60, required: 80, unit: 'm', status: 'pass' },
      reference: { document: 'TRVB F 134' },
    },
    {
      type: 'acoustic_check',
      title: 'Schallschutz',
      sound_class: 'B',
      checks: [
        {
          path_label: 'Wohnungstrennwand',
          metric: 'DnTw',
          check: { label: 'DnTw', value: 55, required: 55, unit: 'dB', status: 'pass' },
          reference: { document: 'OIB 5' },
        },
      ],
    },
    {
      type: 'fire_compartment',
      title: 'Brandabschnitte',
      storey_label: '2.OG',
      gebaeudeklasse: 'GK 4',
      compartments: [
        { label: 'BA 1', area: { label: 'Fläche', value: 800, required: 1200, unit: 'm²', status: 'pass' }, use: 'Wohnen' },
      ],
      reference: { document: 'OIB 2' },
    },
    {
      type: 'thermal_envelope',
      title: 'Wärmeschutz',
      components: [
        { label: 'Außenwand', kind: 'wall', u_value: { label: 'U', value: 0.2, required: 0.35, unit: 'W/(m²K)', status: 'pass' } },
      ],
      reference: { document: 'OIB 6' },
    },
    {
      type: 'energy_performance',
      title: 'Energieausweis',
      energy_class: 'B',
      hwb: { label: 'HWB', value: 42, required: 50, unit: 'kWh/(m²a)', status: 'pass' },
      fgee: { label: 'fGEE', value: 0.8, required: 0.85, unit: '', status: 'pass' },
      reference: { document: 'OIB 6' },
    },
    {
      type: 'elevator_requirement',
      title: 'Aufzug',
      storeys_served: 5,
      entrance_level_index: 0,
      is_required: true,
      requirement_note: 'ab 5 Geschossen',
      cabin_width: { label: 'Breite', value: 110, required: 110, unit: 'cm', status: 'pass' },
      cabin_depth: { label: 'Tiefe', value: 140, required: 140, unit: 'cm', status: 'pass' },
      door_width: { label: 'Türbreite', value: 90, required: 90, unit: 'cm', status: 'pass' },
      reference: { document: 'OIB 4' },
    },
    {
      type: 'parking_requirement',
      title: 'Stellplätze',
      car_spaces: { label: 'Kfz', value: 12, required: 10, unit: '', status: 'pass' },
      bicycle_spaces: { label: 'Rad', value: 20, required: 20, unit: '', status: 'pass' },
      basis: '1 Stpl. je 100 m² BGF',
      reference: { document: 'Bauordnung' },
    },
    {
      type: 'document_grid',
      title: 'Dokumente',
      query: 'Fluchtwege',
      documents: [{ file_name: 'einreichplan.pdf', summary: 'Einreichplan', snippet: 'Fluchtweg', page: 3 }],
    },
    { type: 'ifc_viewer', title: 'Modell' },
    { type: 'ifc_compliance', title: 'Prüfbuch' },
    { type: 'ifc_schedule', title: 'Raumbuch' },
    { type: 'ifc_element', title: 'Wand', global_id: '0abc' },
    { type: 'ifc_diff', title: 'Änderungen', base_model_file: 'a.ifc' },
    { type: 'ifc_model_picker', title: 'Modelle des Projekts' },
  ]

  /**
   * One card of every type in the catalogue.
   *
   * Derived from `gridCardSchema` rather than typed out. The hand-written array
   * this replaced could not fail: a card type added to the union simply never
   * entered it, so "every card in the catalogue" was a claim about a list, not
   * about the catalogue — and thirteen types were outside it. Anything without
   * an authored body falls back to the gallery's preview fixture, which
   * `preview-fixtures.spec.ts` already forces a new type to supply.
   */
  const authored = new Map(authoredCards.map((card) => [card.type as string, card]))
  const everyCardType: Record<string, unknown>[] = [...gridCardSchema.optionsMap.keys()]
    .filter((type): type is string => typeof type === 'string')
    .map((type) => authored.get(type) ?? (previewFixtureFor(type) as Record<string, unknown> | undefined))
    .filter((card): card is Record<string, unknown> => card !== undefined)

  it('covers every card type in the union', () => {
    const covered = new Set(everyCardType.map((card) => card.type))
    const uncovered = [...gridCardSchema.optionsMap.keys()].filter((type) => !covered.has(type))
    expect(
      uncovered,
      'no authored body and no preview fixture — add one, or the export is untested for this type'
    ).toEqual([])
  })

  it.each([
    ['de', german],
    ['en', english],
  ])('resolves every key in %s', (locale, t) => {
    const output = text(
      buildAnswerDocument(
        input({
          cards: everyCardType,
          citations: storedCitations,
          confidence: { level: 'low', reason: 'Wenig Belege.', cappedReason: 'ungrounded' },
        }),
        t,
        locale as 'de' | 'en'
      )
    )

    const unresolved = output.match(/answerExport\.[\w.]+/g) ?? []
    expect(unresolved, `unresolved translation keys in the ${locale} document`).toEqual([])
  })

  it('exports every card in the catalogue, so none is silently lost', () => {
    // Card by card rather than all at once: a card that contributes NOTHING is
    // invisible in a document full of other cards, and "nothing" is exactly the
    // failure — a finding the answer made that the exported file does not.
    const withoutCards = text(buildAnswerDocument(input({ cards: [] }), german, 'de')).length

    for (const card of everyCardType) {
      const output = text(buildAnswerDocument(input({ cards: [card] }), german, 'de'))
      expect(
        output.length,
        `card ${card.type} added nothing to the document`
      ).toBeGreaterThan(withoutCards)
      // Where the card carries a heading of its own, that heading is what the
      // reader looks for in the file.
      const heading = typeof card.title === 'string' ? card.title : ''
      if (heading) {
        expect(output, `card ${card.type} is missing from the document`).toContain(heading)
      }
    }
  })
})
