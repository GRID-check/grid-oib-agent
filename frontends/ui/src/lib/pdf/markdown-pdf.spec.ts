/**
 * @vitest-environment node
 *
 * The markdown → PDF renderer, read back by a parser that is not react-pdf.
 *
 * Every assertion here goes through `test-utils/read-pdf`, which parses the
 * produced bytes with pdf.js. That is the whole point: an assertion on the
 * react-pdf element tree proves a `<Text>` was described, never that the words
 * reached a file somebody can open. For the marking this feature exists to
 * carry, "described" is not the claim — the claim is that the sentence is on
 * page one of the artifact that reaches the Behörde.
 *
 * `@vitest-environment node` is load-bearing: `@react-pdf/renderer` has a
 * `browser` field in its package.json, and under the suite's default happy-dom
 * environment the bundler resolves the web build, whose `renderToStream`
 * throws "a web specific API".
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readPdf, normalizePdfText } from '@/test-utils/read-pdf'
import { AI_GENERATOR_NAME } from '@/lib/ai-provenance'
import { getDictionary } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import { answerExport as de } from '@/i18n/dictionaries/de/answer-export'
import { answerExport as en } from '@/i18n/dictionaries/en/answer-export'
import { legalBasisSection } from './legal-basis'
import { PDF_MEDIA_TYPE, renderMarkdownPdf } from './markdown-pdf'

const REPORT = '# Brandschutz Straßenhäuser\n\nDie Fluchtwegbreite beträgt 1,20 m.\n'

/**
 * Where a run of text is DRAWN on page one, as its x coordinate in points.
 *
 * `read-pdf.ts` answers "what does the page say", which is the right question
 * for almost everything in this file. Two claims here are not about the words
 * at all — that a long label does not paint over its own value, and that a
 * 160-character excerpt is not squeezed into a 110pt-indented column — and both
 * read identically either way. So those two are asked of the geometry instead,
 * with pdf.js reached directly for the same reason `read-pdf.ts` reaches it.
 */
async function drawnAt(bytes: Uint8Array, needle: string): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    // A COPY: pdf.js transfers the buffer it is handed, so the second question
    // asked of one rendering would otherwise be asked of a detached array.
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(
      new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
    ),
  })
  const document = await task.promise
  const content = await (await document.getPage(1)).getTextContent()
  const item = content.items.find((entry) => 'str' in entry && entry.str.includes(needle))
  await task.destroy()
  // `transform[4]` is the text matrix's x translation — the left edge of the run.
  if (!item || !('transform' in item)) throw new Error(`"${needle}" was never drawn`)
  return item.transform[4]
}

/** The PDF magic. A file that does not start with it is not one. */
const magic = (bytes: Uint8Array): string =>
  new TextDecoder('latin1').decode(bytes.subarray(0, 5))

describe('renderMarkdownPdf', () => {
  it('produces a file pdf.js can open, with the markdown’s own words in it', async () => {
    const bytes = await renderMarkdownPdf(REPORT)

    expect(magic(bytes)).toBe('%PDF-')
    expect(PDF_MEDIA_TYPE).toBe('application/pdf')

    const pdf = await readPdf(bytes)
    expect(pdf.pageCount).toBe(1)
    expect(pdf.text).toContain('Brandschutz Straßenhäuser')
    expect(pdf.text).toContain('Die Fluchtwegbreite beträgt 1,20 m.')
  })

  /**
   * The default path — `POST /api/generate-pdf`, a person downloading prose
   * they have read on screen. A marking on every PDF marks nothing, so the
   * absence here is the feature, and it is asserted rather than assumed.
   */
  it('marks nothing when the caller asks for no marking', async () => {
    const pdf = await readPdf(await renderMarkdownPdf(REPORT))

    expect(pdf.text).not.toContain(de.aiNotice.title)
    expect(pdf.info.Keywords).toBeUndefined()
    expect(pdf.info.Subject).toBeUndefined()
    // react-pdf's own default, i.e. nothing this repo wrote. Asserted so that a
    // future default of `Piloti` cannot arrive unnoticed and stamp every export.
    expect(pdf.info.Creator).toBe('react-pdf')
  })

  it('prints the notice the caller supplied, on the first page', async () => {
    const bytes = await renderMarkdownPdf(REPORT, {
      notice: { title: de.aiNotice.title, body: de.aiNotice.body },
    })
    const pdf = await readPdf(bytes)

    // The whole sentence, not a fragment: „KI-generiert — nicht geprüft" is an
    // em dash and two umlauts, and the failure mode of a font or encoding that
    // cannot carry them is dropped characters, not an exception.
    expect(pdf.text).toContain(normalizePdfText(de.aiNotice.title))
    expect(pdf.text).toContain(normalizePdfText(de.aiNotice.body))
    // Before the report, or a reader meets the claims before the warning about
    // them. `indexOf` on the extracted stream is reading order.
    expect(pdf.text.indexOf(de.aiNotice.title)).toBeLessThan(
      pdf.text.indexOf('Brandschutz Straßenhäuser')
    )
  })

  /**
   * Both locales, because the marking is not optional in either and the .docx
   * export's own `label-coverage` reasoning applies unchanged: a key that
   * renders in German and not in English ships an unmarked document to half the
   * users. No new keys were added for the PDF — it reads `answerExport.aiNotice`,
   * the same two strings the .docx prints — so this is the test that the reuse
   * is real rather than intended.
   */
  it.each([
    ['de', de.aiNotice],
    ['en', en.aiNotice],
  ])('carries the %s notice through to the rendered page', async (_locale, notice) => {
    const pdf = await readPdf(
      await renderMarkdownPdf(REPORT, { notice: { title: notice.title, body: notice.body } })
    )

    expect(pdf.text).toContain(normalizePdfText(notice.title))
    expect(pdf.text).toContain(normalizePdfText(notice.body))
  })

  /**
   * The default path again, for the two props this file grew.
   *
   * `POST /api/generate-pdf` passes neither, and its output has to stay what it
   * was: prose a person read on screen, with no block above it claiming to
   * identify a project it was never told about.
   */
  it('prints no header and no section when the caller supplies neither', async () => {
    const pdf = await readPdf(await renderMarkdownPdf(REPORT))

    expect(pdf.pageCount).toBe(1)
    expect(pdf.text).toBe(
      normalizePdfText('Brandschutz Straßenhäuser Die Fluchtwegbreite beträgt 1,20 m.')
    )
  })

  describe('the identification block', () => {
    it('prints the title and every row the caller gave it, in that order', async () => {
      const pdf = await readPdf(
        await renderMarkdownPdf('Die Fluchtwegbreite beträgt 1,20 m.\n', {
          header: {
            title: 'Brandschutz Straßenhäuser',
            rows: [
              { label: 'Projekt', value: 'Haus Anna' },
              { label: 'Standort', value: 'Quellenstraße 12, 1100 Wien' },
              { label: 'Analyse-ID', value: 'run_7', mono: true },
            ],
          },
        })
      )

      expect(pdf.text).toBe(
        normalizePdfText(
          'Brandschutz Straßenhäuser Projekt Haus Anna Standort Quellenstraße 12, 1100 Wien ' +
            'Analyse-ID run_7 Die Fluchtwegbreite beträgt 1,20 m.'
        )
      )
    })

    /**
     * Both locales, for the reason the notice is asserted in both: a label that
     * renders in German and not in English ships an unidentified document to
     * half the users. Read out of the dictionaries rather than spelled here, so
     * this is a test that the words on the cover ARE the dictionary's words —
     * and „Gebäudeklasse" is the one that would fail by silently dropping a
     * character rather than by throwing, if the font could not carry it.
     */
    it.each([
      ['de', 'de' as const],
      ['en', 'en' as const],
    ])('carries the %s cover labels through to the rendered page', async (_name, locale) => {
      const { answerExport } = getDictionary(locale)
      const labels = [
        answerExport.project,
        answerExport.reportCover.location,
        answerExport.reportCover.bundesland,
        answerExport.fields.gebaeudeklasse,
        answerExport.createdAt,
        answerExport.reportCover.author,
        answerExport.reportCover.analysisId,
      ]
      const pdf = await readPdf(
        await renderMarkdownPdf(REPORT, {
          header: { rows: labels.map((label) => ({ label, value: 'Wien' })) },
        })
      )

      for (const label of labels) expect(pdf.text).toContain(normalizePdfText(label))
    })

    /**
     * The regression this whole feature must not become. „KI-generiert — nicht
     * geprüft" is the thing standing between a draft and a liability, and a
     * cover sheet that pushed it down the page would be worse than no cover
     * sheet at all. The order is fixed in the renderer rather than in the
     * caller's argument, so this asserts it where it is decided.
     */
    it('never lets the identification block above the AI marking', async () => {
      const pdf = await readPdf(
        await renderMarkdownPdf(REPORT, {
          notice: { title: de.aiNotice.title, body: de.aiNotice.body },
          header: { title: 'Brandschutz Straßenhäuser', rows: [{ label: 'Projekt', value: 'Haus Anna' }] },
        })
      )

      expect(pdf.text.indexOf(normalizePdfText(de.aiNotice.title))).toBe(0)
      expect(pdf.text.indexOf(normalizePdfText(de.aiNotice.body))).toBeLessThan(
        pdf.text.indexOf('Brandschutz Straßenhäuser')
      )
      expect(pdf.text.indexOf('Brandschutz Straßenhäuser')).toBeLessThan(
        pdf.text.indexOf('Haus Anna')
      )
    })

    /**
     * The boundary `styles.factLabel` is shaped around.
     *
     * A label wider than its column does not get CLIPPED — the glyphs paint
     * past the box — and with hyphenation disabled repo-wide a single-word
     * label has no break opportunity. With a fixed-width column the label ran
     * straight over its own value: „Katastralgemeindenummer" is 118pt of
     * Helvetica standing in 110pt, and „Wien" was drawn underneath its last
     * two letters, on a page going to a Behörde.
     *
     * Asserted on GEOMETRY and not on the extracted text, which is the second
     * thing this test had to learn: pdf.js still reports the two as separate
     * items when they overlap, so the text reads „Katastralgemeindenummer
     * Wien" whether they collide or not. Where the value is DRAWN is the claim,
     * so that is what is read back — the value of a long-labelled row has to
     * start further right than the value of a short-labelled one.
     */
    it('pushes a value right rather than letting a long label run over it', async () => {
      const valueX = async (label: string): Promise<number> =>
        drawnAt(
          await renderMarkdownPdf('Body.\n', { header: { rows: [{ label, value: 'Wien' }] } }),
          'Wien'
        )

      const short = await valueX('Standort')
      const long = await valueX('Katastralgemeindenummer')

      expect(long).toBeGreaterThan(short)
    })

    /**
     * A block with nothing in it prints nothing. An empty bordered strip above
     * a report reads as content that failed to print — a worse statement than
     * the absence it would stand in for.
     *
     * Asserted on the BYTE COUNT and not only on the extracted text, because
     * the thing that would be wrong is a rule and a 10pt gap, and neither of
     * those is text: with the guard removed the page reads identically and the
     * file grows by the border's drawing operators. "Byte-for-byte what it
     * would have been with no header at all" is the actual claim.
     */
    it('prints nothing at all for a header with no title and no rows', async () => {
      const empty = await renderMarkdownPdf(REPORT, { header: { rows: [] } })
      const absent = await renderMarkdownPdf(REPORT)

      expect(empty.byteLength).toBe(absent.byteLength)
      expect((await readPdf(empty)).text).toBe(
        normalizePdfText('Brandschutz Straßenhäuser Die Fluchtwegbreite beträgt 1,20 m.')
      )
    })

    /**
     * The identifier, actually set in a monospace face.
     *
     * `docs/design/grid-design-language.md` §3 asks for monospace on
     * identifiers, and it is not decoration: a run id is TRANSCRIBED, and
     * proportional Helvetica makes `1`/`l` and `0`/`O` a guess for the person
     * looking the document up. The extracted text is the same either way, so
     * the claim is checked where it is true — the font the file names for the
     * bytes it draws. `REPORT` contains no code block, so `Courier` reaches
     * this file only through the row that asked for it.
     */
    it('sets an identifier row in monospace and leaves the others alone', async () => {
      const asId = await renderMarkdownPdf(REPORT, {
        header: { rows: [{ label: 'Analyse-ID', value: 'run_7', mono: true }] },
      })
      const asProse = await renderMarkdownPdf(REPORT, {
        header: { rows: [{ label: 'Analyse-ID', value: 'run_7' }] },
      })
      const namesCourier = (bytes: Uint8Array): boolean =>
        new TextDecoder('latin1').decode(bytes).includes('Courier')

      expect(namesCourier(asId)).toBe(true)
      expect(namesCourier(asProse)).toBe(false)
    })
  })

  describe('an appended section', () => {
    /**
     * A `legal_basis` card as `models.py` declares it, built into a section by
     * `legal-basis.ts` and read back off the page — the citation an architect
     * is actually asked to produce, in the artifact they attach.
     */
    const CARD = {
      type: 'legal_basis',
      law: 'OIB-Richtlinie 2',
      lane: 'baurecht_oib',
      edition: 'Ausgabe Mai 2023',
      article: '§ 3',
      section: 'Punkt 3.1',
      summary: 'Fluchtwege müssen ins Freie oder in einen sicheren Bereich führen.',
      original_text:
        'Fluchtwege sind so auszubilden, dass sie im Brandfall über eine ausreichende Zeitspanne sicher benützbar sind und ins Freie oder in einen sicheren Bereich führen.',
    }

    it.each([
      ['de', 'de' as const],
      ['en', 'en' as const],
    ])(
      'carries the %s field names of a Fundstelle through to the page',
      async (_name, locale) => {
        const dictionary = getDictionary(locale)
        const t = createTranslator(dictionary, 'answerExport')
        const bytes = await renderMarkdownPdf(REPORT, {
          sections: legalBasisSection([CARD], t),
        })
        const pdf = await readPdf(bytes)

        // Every word here is read out of the dictionary rather than spelled in
        // the assertion: the claim is that the PDF prints the SAME labels the
        // .docx export prints, not that it prints some German.
        expect(pdf.text).toContain(normalizePdfText(dictionary.answerExport.legalBasis))
        expect(pdf.text).toContain(normalizePdfText(dictionary.answerExport.cardTypes.legal_basis))
        expect(pdf.text).toContain(normalizePdfText(dictionary.answerExport.fields.law))
        expect(pdf.text).toContain(normalizePdfText(dictionary.answerExport.fields.article))
        expect(pdf.text).toContain(normalizePdfText(dictionary.answerExport.fields.section))
        expect(pdf.text).toContain(normalizePdfText(dictionary.answerExport.fields.original_text))
        // The wire token, spelled as the word — never as `baurecht_oib`.
        expect(pdf.text).toContain(normalizePdfText(dictionary.answerExport.values.lane.baurecht_oib))
        expect(pdf.text).not.toContain('baurecht_oib')
        // And the excerpt itself, verbatim: it is the one part of a citation a
        // reviewer checks against the regulation.
        expect(pdf.text).toContain(normalizePdfText(CARD.original_text))
      }
    )

    /**
     * The reading order the .docx builds the same card in: the short fields
     * share one block, the long ones follow as their own paragraphs, and the
     * whole section sits after the report rather than inside it.
     */
    it('prints the Fundstelle in the order the .docx prints it', async () => {
      const t = createTranslator(getDictionary('de'), 'answerExport')
      const pdf = await readPdf(
        await renderMarkdownPdf(REPORT, { sections: legalBasisSection([CARD], t) })
      )

      expect(pdf.text).toBe(
        normalizePdfText(
          'Brandschutz Straßenhäuser Die Fluchtwegbreite beträgt 1,20 m. ' +
            'Rechtsgrundlagen Rechtsgrundlage ' +
            'Gesetz / Richtlinie OIB-Richtlinie 2 Paragraf § 3 Punkt Punkt 3.1 ' +
            'Zusammenfassung Fluchtwege müssen ins Freie oder in einen sicheren Bereich führen. ' +
            'Originalwortlaut ' +
            CARD.original_text +
            ' Rechtsquelle OIB Ausgabe Ausgabe Mai 2023'
        )
      )
    })

    /**
     * A long value is a paragraph; a short one is a row. The distinction is
     * invisible in the extracted text — both print „Originalwortlaut" and then
     * the words — and it is the difference between an excerpt set across the
     * full measure and one squeezed into the 110pt-indented value column, three
     * words to a line. So it is asked of the geometry: the excerpt has to start
     * at the page's own left margin, where the report's prose starts, and the
     * paragraph number beside it must not.
     */
    it('sets a long excerpt across the measure and a short field in its column', async () => {
      const t = createTranslator(getDictionary('de'), 'answerExport')
      const bytes = await renderMarkdownPdf(REPORT, { sections: legalBasisSection([CARD], t) })

      const bodyText = await drawnAt(bytes, 'Die Fluchtwegbreite')
      const excerpt = await drawnAt(bytes, 'Fluchtwege sind so auszubilden')
      const article = await drawnAt(bytes, '§ 3')

      expect(excerpt).toBe(bodyText)
      expect(article).toBeGreaterThan(bodyText)
    })

    it.each([
      ['no cards at all', undefined],
      ['a value that is not a list', { type: 'legal_basis' }],
      ['cards of every other type', [{ type: 'summary', content: 'Zusammenfassung.' }]],
      ['a legal_basis card with nothing printable on it', [{ type: 'legal_basis' }]],
    ])('prints no heading standing over nothing when there is %s', async (_case, cards) => {
      const t = createTranslator(getDictionary('de'), 'answerExport')
      const sections = legalBasisSection(cards, t)
      const pdf = await readPdf(await renderMarkdownPdf(REPORT, { sections }))

      expect(sections).toEqual([])
      expect(pdf.text).not.toContain('Rechtsgrundlage')
      expect(pdf.text).toBe(
        normalizePdfText('Brandschutz Straßenhäuser Die Fluchtwegbreite beträgt 1,20 m.')
      )
    })

    /**
     * A stored card is jsonb from a backend that may be newer than this build.
     * Every field of a `LegalBasisCard` is `str | None` today; a field that
     * arrives as something else is dropped rather than stringified, because
     * „Paragraf  [object Object]" in a submission document is worse than a
     * citation that is missing its § and visibly so.
     */
    it('drops a field a newer backend stored as something other than text', async () => {
      const dictionary = getDictionary('de')
      const t = createTranslator(dictionary, 'answerExport')
      const pdf = await readPdf(
        await renderMarkdownPdf(REPORT, {
          sections: legalBasisSection(
            [{ type: 'legal_basis', law: 'OIB-Richtlinie 2', article: { text: '§ 3' } }],
            t
          ),
        })
      )

      expect(pdf.text).toContain('OIB-Richtlinie 2')
      expect(pdf.text).not.toContain('[object Object]')
      expect(pdf.text).not.toContain(dictionary.answerExport.fields.article)
    })

    /** Two Fundstellen are two headed blocks, not one run-on list of rows. */
    it('separates two Fundstellen with a heading each', async () => {
      const t = createTranslator(getDictionary('de'), 'answerExport')
      const pdf = await readPdf(
        await renderMarkdownPdf(REPORT, {
          sections: legalBasisSection(
            [
              { type: 'legal_basis', law: 'OIB-Richtlinie 2', article: '§ 3' },
              { type: 'legal_basis', law: 'Wiener Bauordnung', article: '§ 108' },
            ],
            t
          ),
        })
      )

      expect(pdf.text.match(/Rechtsgrundlage /g)).toHaveLength(2)
      expect(pdf.text.indexOf('OIB-Richtlinie 2')).toBeLessThan(
        pdf.text.indexOf('Wiener Bauordnung')
      )
    })
  })

  describe('the machine-readable marking', () => {
    it('writes the same property names the .docx custom properties use', async () => {
      const bytes = await renderMarkdownPdf(REPORT, {
        title: 'Brandschutz Straßenhäuser',
        notice: { title: de.aiNotice.title, body: de.aiNotice.body },
        aiProvenance: { runId: 'run_7' },
      })
      const pdf = await readPdf(bytes)

      expect(pdf.info.Keywords).toBe(
        'AIGenerated=true; AIGenerator=Piloti; AIHumanReviewed=false; AIRunId=run_7'
      )
      expect(pdf.info.Creator).toBe(AI_GENERATOR_NAME)
      expect(pdf.info.Title).toBe('Brandschutz Straßenhäuser')
      // The one Info field a person sees in a viewer's properties panel, so the
      // marking survives for a reader who never scrolls to page one.
      expect(pdf.info.Subject).toBe(de.aiNotice.title)
    })

    /**
     * A run id nobody can look up reads like an audit trail, so the property is
     * absent rather than empty when the caller has no run to name.
     */
    it('omits the run id rather than writing an empty one', async () => {
      const pdf = await readPdf(await renderMarkdownPdf(REPORT, { aiProvenance: {} }))

      expect(pdf.info.Keywords).toBe(
        'AIGenerated=true; AIGenerator=Piloti; AIHumanReviewed=false'
      )
    })
  })
})
