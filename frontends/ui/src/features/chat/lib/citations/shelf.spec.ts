/**
 * @vitest-environment node
 */
/**
 * The shelf travels as DATA (ADR-0047), end to end on the TypeScript side.
 *
 * One fact — which shelf a retrieved chunk came from — used to be destroyed at
 * the wire and guessed back twice: once from a collection-id prefix, once from
 * a German qualifier inside a citation key. These cases pin the replacement:
 *
 *  - the shelf is READ from the payload, never derived from `collection`;
 *  - an absent or unrecognised shelf is UNKNOWN and renders unattributed —
 *    never defaulted to base law, which is what `collectionScope` used to do;
 *  - a private session attachment is no longer filed under "Projektwissen";
 *  - keys already persisted with a German qualifier still resolve.
 */

import { describe, test, expect } from 'vitest'
import { buildCitationModel, decodeCitations, documentShelfLabel, documentTabLabel } from './index'
import { citationFromWire } from '../wire-citation'
import { parseKbLocator } from './locator'
import { encodeCitations } from './persistence'
import type { CitationSource, WireCitationSource } from '../../types'

const NOW = new Date('2026-08-12T09:00:00Z')

/** One structured wire source, as `source_entry_to_wire` emits it. */
const wire = (overrides: Partial<WireCitationSource>): WireCitationSource => ({
  content: '[KB] Grundriss.pdf, p.2',
  file_name: 'Grundriss.pdf',
  page: 2,
  origin: 'kb',
  kind: 'projekt',
  ...overrides,
})

/** The document the chips and the Herleitung card render, built as production does. */
const documentFor = (source: WireCitationSource) => {
  const [document] = buildCitationModel({
    citations: [citationFromWire(source, { timestamp: NOW })],
  })
  if (!document) throw new Error('fixture produced no document')
  return document
}

describe('the shelf arrives explicitly', () => {
  test('the wire field survives the mapping onto a citation', () => {
    expect(citationFromWire(wire({ shelf: 'session' }), { timestamp: NOW }).shelf).toBe('session')
    expect(citationFromWire(wire({ shelf: 'archiv' }), { timestamp: NOW }).shelf).toBe('archiv')
  })

  test('the model takes the shelf the payload states', () => {
    expect(documentFor(wire({ shelf: 'session' })).shelf).toBe('session')
    expect(documentFor(wire({ shelf: 'base', kind: 'baurecht' })).shelf).toBe('base')
  })

  test('the shelf outranks the collection id, which no longer says anything', () => {
    // The prefix table is deleted: `proj_alpha` used to force `projekt` on this
    // document no matter what the payload said.
    const doc = documentFor(wire({ collection: 'proj_alpha', shelf: 'session' }))

    expect(doc.shelf).toBe('session')
    expect(doc.collection).toBe('proj_alpha')
  })

  test('a shelf survives being persisted and read back', () => {
    const citation = citationFromWire(wire({ shelf: 'session' }), { timestamp: NOW })
    const restored = decodeCitations(encodeCitations([citation]), NOW)

    expect(restored?.[0]?.shelf).toBe('session')
  })
})

describe('an unknown shelf renders unattributed', () => {
  test('a payload with no shelf leaves the document unattributed', () => {
    // Not "base", not "project": nothing. The collection id is present and would
    // have been prefix-matched into a shelf before ADR-0047.
    const doc = documentFor(wire({ collection: 'archiv_org1', kind: 'buero' }))

    expect(doc.shelf).toBeUndefined()
    expect(documentShelfLabel(doc)).toBeUndefined()
  })

  test('an unrecognised shelf value is dropped, not defaulted to base law', () => {
    const doc = documentFor(wire({ shelf: 'baurecht', collection: 'oib_knowledge' }))

    expect(doc.shelf).toBeUndefined()
    expect(documentShelfLabel(doc)).toBeUndefined()
  })

  test('an unattributed document still renders its display taxonomy', () => {
    // Shelf and SourceKind are separate axes: losing the shelf must not cost the
    // document its provenance family, it must only stop it claiming a shelf.
    const doc = documentFor(wire({ collection: 'archiv_org1', kind: 'buero' }))

    expect(doc.kind).toBe('buero')
    expect(documentTabLabel(doc)).toBe('Büroarchiv')
  })

  test('a stored message written before the field existed decodes to no shelf', () => {
    const restored = decodeCitations(
      { v: 1, sources: [{ content: '[KB] Plan.pdf, p.1', file_name: 'Plan.pdf', page: 1 }] },
      NOW
    )

    expect(restored?.[0]?.shelf).toBeUndefined()
  })
})

describe('a private session attachment is not project knowledge', () => {
  test('a session source is labelled "Private Sitzung", never "Projektwissen"', () => {
    const doc = documentFor(wire({ shelf: 'session', kind: 'projekt' }))

    expect(documentShelfLabel(doc)).toBe('Private Sitzung')
    expect(documentTabLabel(doc)).toBe('Private Sitzung')
    expect(documentTabLabel(doc)).not.toBe('Projektwissen')
  })

  test('a genuine project document is still Projektwissen', () => {
    const doc = documentFor(wire({ shelf: 'project', kind: 'projekt' }))

    expect(documentTabLabel(doc)).toBe('Projektwissen')
  })

  test('a fine lane label still wins — the shelf does not overwrite the taxonomy', () => {
    const doc = documentFor(
      wire({ shelf: 'base', kind: 'baurecht', lane: 'baurecht_oib', lane_label: 'OIB-Richtlinie' })
    )

    expect(doc.shelf).toBe('base')
    expect(documentTabLabel(doc)).toBe('OIB-Richtlinie')
  })
})

describe('legacy citation keys still parse', () => {
  const legacy = (citationKey: string): CitationSource => ({
    id: 'c-1',
    content: `[KB] ${citationKey}`,
    citationKey,
    timestamp: NOW,
    isCited: true,
  })

  test('a German qualifier in a persisted key names the shelf', () => {
    const [buero] = buildCitationModel({ citations: [legacy('Plan.pdf (Büroarchiv), p.3')] })
    const [projekt] = buildCitationModel({ citations: [legacy('Plan.pdf (Projektwissen), p.3')] })
    const [basis] = buildCitationModel({ citations: [legacy('Plan.pdf (Basiswissen), p.3')] })

    expect(buero?.shelf).toBe('archiv')
    expect(projekt?.shelf).toBe('project')
    expect(basis?.shelf).toBe('base')
  })

  test('the qualifier is not part of the filename', () => {
    const [doc] = buildCitationModel({ citations: [legacy('Plan.pdf (Büroarchiv), p.3')] })

    expect(doc?.fileName).toBe('Plan.pdf')
    expect(doc?.loci[0]?.page).toBe(3)
  })

  test('an explicit shelf beats the legacy qualifier when a key carries both', () => {
    const [doc] = buildCitationModel({
      citations: [
        citationFromWire(
          {
            content: '[KB] Plan.pdf (Projektwissen), p.3',
            citation_key: 'Plan.pdf (Projektwissen), p.3',
            file_name: 'Plan.pdf',
            page: 3,
            shelf: 'session',
          },
          { timestamp: NOW }
        ),
      ],
    })

    expect(doc?.shelf).toBe('session')
  })

  /**
   * An EXPLICIT shelf and a GUESSED one are two different claims, and they must
   * not be settled by whichever observation happened to arrive first.
   *
   * One document is folded together from many wire sources — the registry keys
   * on `(collection, filename, page)`, so a file read at three pages arrives as
   * three sources. If the first of them carries only a legacy key qualifier and
   * the second carries the real shelf, "first non-empty wins" hands the document
   * to the GUESS: a private attachment cited at p.3 and p.4 could be filed under
   * "Projektwissen" purely because of the order the pages came in.
   */
  describe('explicit and guessed shelves do not compete on arrival order', () => {
    /** A legacy source: a qualified key, no shelf field. Same document as below. */
    const guessed: CitationSource = {
      id: 'c-guess',
      content: '[KB] Plan.pdf (Projektwissen), p.3',
      citationKey: 'Plan.pdf (Projektwissen), p.3',
      fileName: 'Plan.pdf',
      page: 3,
      timestamp: NOW,
      isCited: true,
    }

    /** The same document, one page on, with the shelf stated as data. */
    const stated: CitationSource = {
      id: 'c-wire',
      content: '[KB] Plan.pdf, p.4',
      citationKey: 'Plan.pdf, p.4',
      fileName: 'Plan.pdf',
      page: 4,
      shelf: 'session',
      timestamp: NOW,
      isCited: true,
    }

    test('the explicit shelf wins even when the qualifier arrives FIRST', () => {
      const [doc] = buildCitationModel({ citations: [guessed, stated] })

      expect(doc?.shelf).toBe('session')
      // Both pages still belong to the one document — the merge is what makes
      // the ordering matter at all.
      expect(doc?.loci.map((locus) => locus.page)).toEqual([3, 4])
    })

    test('and still wins when it arrives first — order changes nothing', () => {
      const [doc] = buildCitationModel({ citations: [stated, guessed] })

      expect(doc?.shelf).toBe('session')
    })

    test('a second explicit shelf does not unseat the first', () => {
      const [doc] = buildCitationModel({
        citations: [stated, { ...guessed, id: 'c-later', shelf: 'archiv' }],
      })

      expect(doc?.shelf).toBe('session')
    })

    test('the qualifier is still used when nothing states a shelf', () => {
      const [doc] = buildCitationModel({ citations: [guessed] })

      expect(doc?.shelf).toBe('project')
    })

    test('prose the model wrote cannot overrule a shelf a wire source guessed', () => {
      // A written source entry is a sentence, so the only shelf it can carry is
      // a qualifier it quoted: an inference, never a statement. Treating it as
      // explicit would let the answer's prose displace the wire's own reading.
      const [doc] = buildCitationModel({
        citations: [{ ...guessed, content: '[KB] Plan.pdf (Büroarchiv), p.3', citationKey: 'Plan.pdf (Büroarchiv), p.3' }],
        entries: [{ number: 1, markdown: 'Plan.pdf (Projektwissen), p.4' }],
      })

      expect(doc?.shelf).toBe('archiv')
    })
  })

  test('an unknown qualifier leaves the document unattributed', () => {
    // Only the three qualifiers the legacy writer could emit are read; anything
    // else is left alone (it may well be part of the filename) and names no
    // shelf, rather than being coerced into one.
    const [doc] = buildCitationModel({
      citations: [{ ...legacy('Bescheid (Kopie).pdf, p.2'), fileName: 'Bescheid (Kopie).pdf' }],
    })

    expect(doc?.shelf).toBeUndefined()
    expect(doc?.fileName).toBe('Bescheid (Kopie).pdf')
  })
})

/**
 * The writer/reader seam on the citation KEY.
 *
 * `shelfLabel` is display copy and may be reworded; the qualifier inside a
 * citation key may NOT, because the backend appends one to keep a key unique
 * when two retrieved files share a name across shelves. The reader therefore
 * has to strip every qualifier the writer can emit — and the writer gained
 * `Private Sitzung` in ADR-0047, which is exactly the case a "legacy means the
 * three old strings" reading would have missed: the qualifier survives, the
 * remainder fails `FILENAME_RE`, and the citation resolves to null.
 *
 * These strings are pinned byte-for-byte against `SHELF_QUALIFIERS` in
 * `src/aiq_agent/common/source_kinds.py`.
 */
describe('citation-key qualifiers the backend can write', () => {
  const cases: ReadonlyArray<readonly [qualifier: string, shelf: string]> = [
    ['Büroarchiv', 'archiv'],
    ['Projektwissen', 'project'],
    ['Basiswissen', 'base'],
    ['Private Sitzung', 'session'],
  ]

  test.each(cases)('strips %s and resolves it to the %s shelf', (qualifier, shelf) => {
    const parsed = parseKbLocator(`Plan.pdf (${qualifier}), p.3`)
    expect(parsed).not.toBeNull()
    expect(parsed?.filename).toBe('Plan.pdf')
    expect(parsed?.shelf).toBe(shelf)
  })

  test('a parenthetical that is part of the filename is left alone', () => {
    const parsed = parseKbLocator('Bescheid (Kopie).pdf, p.1')
    expect(parsed?.filename).toBe('Bescheid (Kopie).pdf')
    expect(parsed?.shelf).toBeUndefined()
  })
})
