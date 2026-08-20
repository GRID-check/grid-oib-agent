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
import { AI_GENERATOR_NAME } from '@/lib/ai-provenance'
import { answerExport as de } from '@/i18n/dictionaries/de/answer-export'
import { answerExport as en } from '@/i18n/dictionaries/en/answer-export'
import { PDF_MEDIA_TYPE, renderMarkdownPdf } from './markdown-pdf'

const REPORT = '# Brandschutz Straßenhäuser\n\nDie Fluchtwegbreite beträgt 1,20 m.\n'

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
