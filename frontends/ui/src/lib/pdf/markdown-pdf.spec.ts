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

import { describe, expect, it } from 'vitest'
import { readPdf, normalizePdfText } from '@/test-utils/read-pdf'
import { AI_GENERATOR_NAME, aiProvenanceMarking } from '@/lib/ai-provenance'
import { answerExport as de } from '@/i18n/dictionaries/de/answer-export'
import { answerExport as en } from '@/i18n/dictionaries/en/answer-export'
import {
  MAX_MARKDOWN_PDF_CHARS,
  TABLE_CELL_COST_CHARS,
  markdownRenderCost,
  MarkdownTooLongError,
  PDF_MEDIA_TYPE,
  renderMarkdownPdf,
} from './markdown-pdf'

/**
 * The mermaid placeholder every call has to supply, and its own words rather
 * than the dictionary's.
 *
 * A marker string, so a test asserting the line is on the page is asserting
 * that THIS caller's string was printed — reading the real German back would
 * pass just as well if the renderer had hardcoded a sentence of its own, which
 * is the failure the required option exists to prevent.
 */
const DIAGRAM_PLACEHOLDER = 'Zeichnung hier nicht wiedergegeben.'
const BASE = { diagramPlaceholder: DIAGRAM_PLACEHOLDER }

/**
 * A marking, which is now what turns the notice on.
 *
 * The two used to be separate options — a `notice` the caller wrote and a
 * `marking` for the Keywords — which meant a document could carry one without
 * the other: marked for exactly one of its two audiences. One field drives
 * both, so that state is no longer reachable.
 */
const MARKING = aiProvenanceMarking({ runId: 'run_7' })

const REPORT = '# Brandschutz Straßenhäuser\n\nDie Fluchtwegbreite beträgt 1,20 m.\n'

// `drawnAt` — the pdf.js geometry probe — went with the two tests that used it.
// Both asked about LAYOUT (a long label painting over its value, a wide excerpt
// squeezed into an indented column), and layout is `lib/pdf/branding.tsx` and
// `blocks-to-pdf.tsx` now, with their own specs. A geometry helper kept here
// for nothing would be the next reader's puzzle.


/** The PDF magic. A file that does not start with it is not one. */
const magic = (bytes: Uint8Array): string =>
  new TextDecoder('latin1').decode(bytes.subarray(0, 5))

describe('renderMarkdownPdf', () => {
  it('produces a file pdf.js can open, with the markdown’s own words in it', async () => {
    const bytes = await renderMarkdownPdf(REPORT, BASE)

    expect(magic(bytes)).toBe('%PDF-')
    expect(PDF_MEDIA_TYPE).toBe('application/pdf')

    const pdf = await readPdf(bytes)
    // A cover sheet and the body: the document the product prints now.
    expect(pdf.pageCount).toBe(2)
    expect(pdf.text).toContain('Brandschutz Straßenhäuser')
    expect(pdf.text).toContain('Die Fluchtwegbreite beträgt 1,20 m.')
  })

  /**
   * The default path — `POST /api/generate-pdf`, a person downloading prose
   * they have read on screen. A marking on every PDF marks nothing, so the
   * absence here is the feature, and it is asserted rather than assumed.
   */
  it('marks nothing when the caller asks for no marking', async () => {
    const pdf = await readPdf(await renderMarkdownPdf(REPORT, BASE))

    expect(pdf.text).not.toContain(de.aiNotice.title)
    expect(pdf.info.Keywords).toBeUndefined()
    expect(pdf.info.Subject).toBeUndefined()
    // react-pdf's own default, i.e. nothing this repo wrote. Asserted so that a
    // Every document the product prints is branded now — `BlocksDocument` sets
    // author, creator and producer to `Piloti`. This used to assert react-pdf's
    // default precisely so a change like that could not arrive unnoticed; it
    // arrived, deliberately, so the assertion follows it rather than the other
    // way round.
    expect(pdf.info.Creator).toBe('Piloti')
  })

  it('prints the notice the caller supplied, on the first page', async () => {
    const bytes = await renderMarkdownPdf(REPORT, {
        ...BASE,
      marking: MARKING,
      locale: 'de',
    })
    const pdf = await readPdf(bytes)

    // The whole sentence, not a fragment: „KI-generiert — nicht geprüft" is an
    // em dash and two umlauts, and the failure mode of a font or encoding that
    // cannot carry them is dropped characters, not an exception.
    expect(pdf.text).toContain(normalizePdfText(de.aiNotice.title))
    expect(pdf.text).toContain(normalizePdfText(de.aiNotice.body))
    // Before the REPORT, which is the claim worth keeping: a reader must not
    // meet what the document asserts before the warning about it. The title is
    // now the cover band above the marking — a heading, not an assertion about
    // the building — so the ordering is checked against the body.
    expect(pdf.text.indexOf(de.aiNotice.title)).toBeLessThan(
      pdf.text.indexOf('Die Fluchtwegbreite')
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
      await renderMarkdownPdf(REPORT, { ...BASE, marking: MARKING, locale: _locale })
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
    const pdf = await readPdf(await renderMarkdownPdf(REPORT, BASE))

    // A cover sheet and the body: the document the product prints now.
    expect(pdf.pageCount).toBe(2)
    expect(pdf.text).toBe(
      normalizePdfText(
        // The cover (lockup + title), then the running header, the page footer
        // and the body. No facts, no marking, no findings — which is what "the
        // caller supplied neither" means now that the chrome is always there.
        'Piloti Brandschutz Straßenhäuser Piloti Brandschutz Straßenhäuser Piloti 2 / 2 ' +
          'Die Fluchtwegbreite beträgt 1,20 m.'
      )
    )
  })

// The identification block moved. It is the document COVER now
  // (`lib/pdf/branding.tsx`), assembled by `documentSections`, and
  // `report-document.spec.tsx` owns its claims — "puts the title and the header
  // facts on the cover, not in the body" is the same assertion this block used
  // to make against a header rendered into the page stream. What stays here is
  // only what this module decides: the marking, the diagram placeholder and the
  // length bound.


// The appended section moved too. A run's cards are rendered by
  // `lib/answer-export/cards.ts` — the shape-walker the .docx export already
  // used — and `report-document.spec.tsx` asserts they go through it
  // ("renders the cards through the shape-walker, not through a card renderer
  // here"). That is why `legal-basis.ts` is gone: it was a second card renderer
  // for one card type, and two walkers over one payload is how the PDF and the
  // Word file come to disagree about a Fundstelle.


  describe('the machine-readable marking', () => {
    it('writes the same property names the .docx custom properties use', async () => {
      const bytes = await renderMarkdownPdf(REPORT, {
        ...BASE,
        title: 'Brandschutz Straßenhäuser',
        marking: MARKING,
        // Subject carries the notice's own words, so the locale has to be
        // stated for the assertion below to name a language.
        locale: 'de',
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
      const pdf = await readPdf(
        await renderMarkdownPdf(REPORT, { ...BASE, marking: aiProvenanceMarking({}) })
      )

      expect(pdf.info.Keywords).toBe(
        'AIGenerated=true; AIGenerator=Piloti; AIHumanReviewed=false'
      )
    })
  })

  /**
   * The admission bound, and why the assertions below are shaped as they are.
   *
   * The claim is not "long input is rejected" — it is that the rejection
   * happens BEFORE the layout pass, because the layout pass is one synchronous
   * block that starves the event loop for its whole duration (measured: a 3 s
   * timer armed before a 128 KiB table-heavy render fired at 32.5 s). Nothing
   * observes a render in progress and nothing stops one, so a bound that ran
   * anywhere but in front of it would not be a bound at all.
   *
   * That is what the wall-clock assertion is for. It is not a performance test:
   * the margin between "refused without rendering" and "rendered" at 2 MiB is
   * milliseconds against many minutes, so the number below is a claim about
   * WHICH CODE RAN, expressed in the only currency this renderer offers.
   */
  describe('the admission bound', () => {
    /** `size` characters of ordinary prose — the cheapest shape to render. */
    const proseOf = (size: number) =>
      'Die Fluchtwegbreite betraegt 1,20 m und ist damit ausreichend bemessen. '.repeat(
        Math.ceil(size / 72)
      ).slice(0, size)

    /** `rows` markdown table rows of four columns — the expensive shape. */
    const tableOf = (rows: number) =>
      `| Bauteil | Anforderung | Nachweis | Quelle |\n|---|---|---|---|\n` +
      '| Trennwand | REI 90 | Pruefzeugnis | OIB-RL 2 |\n'.repeat(rows)

    it('prices a table cell above a prose character', () => {
      // The whole argument for the bound being a COST: the same byte count
      // costs about ten times more as a table than as prose, so a cap that
      // counted characters priced every report as a table and refused the one
      // shape this product actually writes (#624).
      const prose = proseOf(4000)
      const table = tableOf(40)

      expect(markdownRenderCost(prose)).toBe(prose.length)
      expect(markdownRenderCost(table)).toBeGreaterThan(table.length * 2)
      // 42 rows (a header, its delimiter, and 40 body rows) x 4 cells x the
      // per-cell price.
      expect(markdownRenderCost(table) - table.length).toBe(42 * 4 * TABLE_CELL_COST_CHARS)
    })

    it('renders a report the old character cap refused', async () => {
      // 128 KiB of prose: twice the ceiling this bound used to have, and 2.6 s
      // to lay out against the 20.4 s that same ceiling admitted as tables. It
      // is the Deep-Research-Bericht in #624, and the assertion is that it
      // comes back as a PDF rather than as a 400.
      const bytes = await renderMarkdownPdf(proseOf(128 * 1024), BASE)

      expect(new TextDecoder('latin1').decode(bytes.subarray(0, 5))).toBe('%PDF-')
    }, 60_000)

    it('refuses one unit of cost more than the limit, by name', async () => {
      const markdown = proseOf(MAX_MARKDOWN_PDF_CHARS + 1)

      await expect(renderMarkdownPdf(markdown, BASE)).rejects.toThrow(MarkdownTooLongError)
      // The cost and the limit are both on the error because the caller that
      // swallows this (`fileReportIfCommissioned`) logs it and nothing else —
      // "too long" without "how long" tells an operator nothing they can act on.
      await expect(renderMarkdownPdf(markdown, BASE)).rejects.toMatchObject({
        length: MAX_MARKDOWN_PDF_CHARS + 1,
        limit: MAX_MARKDOWN_PDF_CHARS,
      })
    })

    it('still refuses a table-heavy document at very nearly its old size', async () => {
      // The budget IS the cost of the most expensive document the old cap ever
      // admitted — 64 KiB of four-column tables — so raising the ceiling for
      // prose must not have raised it for tables. ~64 KiB of them is refused.
      const markdown = tableOf(1500)

      expect(markdown.length).toBeLessThan(96 * 1024)
      await expect(renderMarkdownPdf(markdown, BASE)).rejects.toThrow(MarkdownTooLongError)
    })

    it('refuses without rendering, which is the only place a refusal can be', async () => {
      // 2 MiB of tables is the input that has to be refused CHEAPLY: rendered,
      // it is minutes of a blocked process and over a gigabyte of peak RSS. If
      // the guard moved below `renderToStream` this would not fail with a wrong
      // value, it would stop answering.
      const table = '| a | b |\n|---|---|\n| Fluchtweg | 1,20 m |\n\n'
      const markdown = table.repeat(Math.ceil((2 * 1024 * 1024) / table.length))
      const started = Date.now()

      await expect(renderMarkdownPdf(markdown, BASE)).rejects.toThrow(MarkdownTooLongError)

      expect(Date.now() - started).toBeLessThan(1000)
    })
  })
})
