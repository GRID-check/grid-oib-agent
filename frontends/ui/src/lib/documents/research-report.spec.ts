/**
 * @vitest-environment node
 *
 * ## Why this spec renders a real PDF
 *
 * The renderer is NOT mocked out. `fileGeneratedDocument` takes a `render`
 * function, and the claim this module is here to make is about what that
 * function produces — a file that previews in the Files pane and carries its
 * marking into the artifact that reaches a Behörde. A mocked renderer can only
 * confirm that arguments were passed to it, which is the same assertion whether
 * the PDF is well-formed or empty.
 *
 * It is still wrapped in a spy (`importOriginal`, not a stub) so the *when* —
 * nothing renders until the service has authorized the write — stays assertable
 * without giving up the *what*.
 *
 * `@vitest-environment node` is load-bearing: `@react-pdf/renderer`'s package
 * has a `browser` field, and under happy-dom the web build's `renderToStream`
 * throws "a web specific API".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const fileGeneratedDocument = vi.fn()
vi.mock('./generated', () => ({
  fileGeneratedDocument: (...args: unknown[]) => fileGeneratedDocument(...args),
}))

const renderMarkdownPdf = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pdf/markdown-pdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf/markdown-pdf')>()
  renderMarkdownPdf.mockImplementation(actual.renderMarkdownPdf)
  return { ...actual, renderMarkdownPdf }
})

vi.mock('@/i18n/server', () => ({
  getTranslations: async () => (key: string) => `t:${key}`,
  getLocale: async () => 'de',
}))

/**
 * The project row the cover block reads its facts off.
 *
 * Mocked at the repository and not at the database, because what this spec is
 * about is which FACTS reach the page — and a drizzle mock would make every
 * assertion below a statement about a query builder instead.
 */
const findProjectInOrg = vi.hoisted(() => vi.fn())
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: (...args: unknown[]) => findProjectInOrg(...args),
}))

/**
 * A project brief as `projects.profile` stores one: confirmed facts, each with
 * its provenance. The three keys the cover prints, plus one it deliberately
 * does not, so "the cover is a selection" is asserted rather than assumed.
 */
const PROFILE = {
  facts: {
    standort_adresse: {
      value: 'Simmeringer Hauptstraße 24, 1110 Wien',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    bundesland: {
      value: 'wien',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    gebaeudeklasse: {
      value: 'GK4',
      confidence: 'confirmed',
      source: 'user_confirmed',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    projektphase: {
      value: 'einreichplanung',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
  },
  goals: {},
  unknowns: [],
  assumptions: {},
}

import type { AuthorizedSession } from '@/lib/auth/types'
import { normalizePdfText, readPdf } from '@/test-utils/read-pdf'
import { MAX_MARKDOWN_PDF_CHARS, MarkdownTooLongError } from '@/lib/pdf/markdown-pdf'
import { aiProvenanceMarking } from '@/lib/ai-provenance'
import type { GeneratedRenderContext } from './generated'
import { fileResearchReport, splitReportTitle } from './research-report'

const SESSION = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession

const REPORT = '# Brandschutz Straßenhäuser\n\nDer Bericht beginnt hier.\n'

/**
 * What the real service hands this producer for `runId: 'run_7'`.
 *
 * `deep_research` files under `agent_run`, which is the one reference kind that
 * IS a run, so the marking carries `AIRunId`. Spelled out here rather than
 * imported from the service so that a change to the seam's answer shows up as a
 * failure in this file too, where the producer's half of the contract lives.
 */
const RUN_MARKING = aiProvenanceMarking({ runId: 'run_7' })

/** Run the renderer the caller handed to the service. */
const runRenderer = () => {
  const input = fileGeneratedDocument.mock.calls[0][0]
  const context: GeneratedRenderContext = {
    projectId: 'proj-1',
    projectName: 'Haus Anna',
    marking: RUN_MARKING,
  }
  return input.render(context)
}

// The cover sheet is dated from the real clock (`research-report.ts` passes
// `new Date()`, deliberately: a report filed today is dated today). The
// assertions below name „20. August 2026", so without a frozen clock they
// passed on exactly one day and failed on 25 August with a diff that looks
// like a formatting change rather than a calendar.
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-20T11:00:00Z'))
  vi.clearAllMocks()
  findProjectInOrg.mockResolvedValue({ id: 'proj-1', name: 'Haus Anna', profile: PROFILE })
  fileGeneratedDocument.mockResolvedValue({
    documentId: 'doc-1',
    filename: 'brandschutz-2026-08-20.pdf',
    folderId: 'folder-1',
    alreadyFiled: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('splitReportTitle', () => {
  it('takes the report’s own H1 as the title and removes it from the body', () => {
    expect(splitReportTitle(REPORT)).toEqual({
      title: 'Brandschutz Straßenhäuser',
      body: 'Der Bericht beginnt hier.\n',
    })
  })

  it('leaves a report without a heading untouched rather than inventing a title', () => {
    const plain = 'Der Bericht beginnt sofort.'
    expect(splitReportTitle(plain)).toEqual({ title: null, body: plain })
  })

  it('does not mistake a deeper heading for the document title', () => {
    const report = '## Abschnitt\n\nText.'
    expect(splitReportTitle(report).title).toBeNull()
  })
})

describe('fileResearchReport', () => {
  it('files through the one service function, as the deep_research producer', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })

    const input = fileGeneratedDocument.mock.calls[0][0]
    expect(input.producer).toBe('deep_research')
    // The identifier only. What KIND of identifier it is is the producer's
    // property, read off `GENERATED_DOCUMENT_PRODUCER_REF_KINDS` inside the
    // service, so this caller cannot state — or misstate — it (migration 0066).
    expect(input.ref).toBe('run_7')
    expect(input.projectId).toBe('proj-1')
    expect(input.title).toBe('Brandschutz Straßenhäuser')
  })

  it('falls back to the export’s own title when the report has no heading', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: 'Text.' })
    expect(fileGeneratedDocument.mock.calls[0][0].title).toBe('t:documentTitle')
  })

  /**
   * The document is filed as a PDF and not as the `.docx` this path first
   * shipped with, because `PREVIEW_TYPES` in `file-preview-pane.tsx` has no
   * entry for a Word document: the report a user had just commissioned landed
   * in Berichte as a generic icon with no in-app preview. The content type is
   * also what `generatedFilename` reads to pick the extension, so a wrong one
   * here is a `.docx` that is not one.
   */
  it('files a PDF — the type the Files pane can preview', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const rendering = await runRenderer()

    expect(rendering.contentType).toBe('application/pdf')
    // The magic number, before anything is parsed: a body that is not a PDF at
    // all would still satisfy every assertion made through a parser mock.
    expect(new TextDecoder('latin1').decode(rendering.bytes.subarray(0, 5))).toBe('%PDF-')
  })

  /**
   * The two markings are independent by design — one is read by a person on
   * page one, the other is detected by a records system without OCR — so a
   * caller that sets one and not the other ships a document that is marked for
   * exactly one of its two audiences. This caller owns passing both.
   *
   * Read back out of the produced bytes rather than off the call arguments:
   * the marking's job is to be IN the file, and „passed to the renderer" and
   * „present in the artifact" are different claims.
   */
  it('sets the printed notice AND the machine-readable provenance', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const rendering = await runRenderer()
    const pdf = await readPdf(rendering.bytes)

    // Handed back to the seam, which checks it against these same bytes before
    // anything is stored. The producer no longer formats its own: the string it
    // returns is the string the context gave it, so the marking in the file and
    // the marking the service verifies cannot be two different answers.
    expect(rendering.marking).toBe(RUN_MARKING)

    // Real German, not this spec's `t:<key>` stub. The stub covers
    // `getTranslations`, which `research-report.ts` uses for the labels it
    // supplies; the DOCUMENT resolves the reader's own dictionary inside
    // `lib/pdf/report-document.ts`. Asserting the sentence itself is the
    // stronger claim anyway — it is what the reader sees, and it is the exact
    // string `answerExport.aiNotice` gives the .docx, so a renderer that wrote
    // its own second copy would not match.
    expect(pdf.text).toContain(normalizePdfText('KI-generiert — nicht geprüft'))
    expect(pdf.text).toContain(normalizePdfText('ein Mensch hat es nicht geprüft'))

    expect(pdf.info.Keywords).toBe(
      'AIGenerated=true; AIGenerator=Piloti; AIHumanReviewed=false; AIRunId=run_7'
    )
    expect(pdf.info.Creator).toBe('Piloti')
  })

  /**
   * The cover block, read back off page one in the order a person reads it.
   *
   * The translator is stubbed as `t:<key>`, so this is also the assertion that
   * every word on the cover comes out of the dictionary: a renderer that spelled
   * „Projekt" itself would print the word rather than the key.
   *
   * Whole-string rather than a list of `toContain`s, because ORDER is the claim
   * — a fact sheet whose date sits between the project and its address is a
   * different document from the one this file describes.
   */
  it('opens with the title, then the marking, then the identifying facts', async () => {
    // The order changed when the report moved onto the product's own document
    // (cover sheet, running header, page footer) instead of a bare page. The
    // title is now the cover BAND — a heading, not a claim about the building —
    // and the marking is the first thing in the cover body.
    //
    // The rule this test exists for is unchanged and still holds: the marking
    // comes before every FACT and before the report itself, so nothing the
    // document asserts is read before the warning about how much to trust it.
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const pdf = await readPdf((await runRenderer()).bytes)

    // Real German, not the `t:` stub: the document is built by
    // `lib/pdf/report-document.ts`, which resolves the reader's own dictionary
    // rather than taking this spec's translator.
    const marking = 'KI-generiert — nicht geprüft'
    expect(pdf.text).toContain(normalizePdfText(marking))

    const at = (needle: string) => pdf.text.indexOf(normalizePdfText(needle))
    expect(at(marking)).toBeGreaterThan(-1)
    // Before every identifying fact …
    for (const fact of ['Haus Anna', 'Simmeringer Hauptstraße 24, 1110 Wien', 'Wien', 'GK4', 'run_7']) {
      expect(at(marking), `marking precedes ${fact}`).toBeLessThan(at(fact))
    }
    // … and before the report's own words.
    expect(at(marking)).toBeLessThan(at('Der Bericht beginnt hier.'))

    // Every fact still reaches the cover. Bundesland is the load-bearing one:
    // it names the Bauordnung the report was checked against.
    for (const fact of [
      'Haus Anna',
      'Simmeringer Hauptstraße 24, 1110 Wien',
      'Wien',
      'GK4',
      '20. August 2026',
      'run_7',
    ]) {
      expect(pdf.text, `cover carries ${fact}`).toContain(normalizePdfText(fact))
    }
    expect(pdf.info.Title).toBe('Brandschutz Straßenhäuser')
  })

  /**
   * The Analyse-ID is set monospace, and it is the only row that is.
   *
   * The extracted text is identical either way, so the claim is checked where
   * it is true — the font the file names for the bytes it draws. It is not
   * typographic taste: a run id is the string somebody TRANSCRIBES to look the
   * document up against the audit trail, and Helvetica makes `1`/`l` a guess.
   */
  it('sets the run id in monospace, and nothing else on the cover', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const { bytes } = await runRenderer()

    // `REPORT` has no code block, so `Courier` reaches this file only through
    // the one row that asked for it.
    expect(new TextDecoder('latin1').decode(bytes).includes('Courier')).toBe(true)
  })

  /**
   * „wien" is the stored token; „Wien" is what the Project Brief panel shows.
   * The cover resolves it through `buildProjectBriefView`, the same builder the
   * Overview uses, so the two surfaces cannot end up naming one Bundesland two
   * different ways — and a Bauakt never carries the machine vocabulary.
   */
  it('prints the brief’s own words for a fact, not the stored token', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const pdf = await readPdf((await runRenderer()).bytes)

    expect(pdf.text).toContain('Wien')
    expect(pdf.text).not.toContain('wien ')
  })

  /**
   * A cover identifies; it does not summarise. `projektphase` is a confirmed
   * fact of the same profile and is deliberately not on the sheet — this is the
   * assertion that the selection is a selection.
   */
  it('does not reprint the rest of the project brief', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const pdf = await readPdf((await runRenderer()).bytes)

    expect(pdf.text).not.toContain('Einreichplanung')
    expect(pdf.text).not.toContain('einreichplanung')
  })

  /**
   * A field with no value produces no line. A report filed from a project with
   * an empty brief must not print „Bundesland" with nothing after it: a reader
   * away from the app cannot tell that apart from a claim that there is none.
   */
  it('drops the facts a project has not captured, and keeps the rest', async () => {
    findProjectInOrg.mockResolvedValue({ id: 'proj-1', name: 'Haus Anna', profile: {} })
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const pdf = await readPdf((await runRenderer()).bytes)

    // The absence is the claim, so it is asserted as an absence rather than by
    // pinning the whole page: an exact-match assertion on a document that now
    // has a cover, a running header and a page footer breaks on chrome and says
    // nothing about the fact that matters.
    for (const label of ['t:reportCover.location', 't:reportCover.bundesland', 't:fields.gebaeudeklasse']) {
      expect(pdf.text, `${label} has no value, so it prints no line`).not.toContain(label)
    }
    expect(pdf.text).toContain('t:project Haus Anna')
    expect(pdf.text).toContain('t:reportCover.analysisId run_7')
    expect(pdf.text).toContain('Der Bericht beginnt hier.')
  })

  /**
   * The cover is ADDED MATTER. A database blip while reading a Gebäudeklasse
   * must not cost the user the filing of a report a multi-minute run produced,
   * so the read fails soft and the document still says what it can confirm.
   */
  it('still files the report when the project brief cannot be read', async () => {
    findProjectInOrg.mockRejectedValue(new Error('connection terminated'))
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const rendering = await runRenderer()
    const pdf = await readPdf(rendering.bytes)

    expect(rendering.contentType).toBe('application/pdf')
    expect(pdf.text).toContain(normalizePdfText('KI-generiert — nicht geprüft'))
    expect(pdf.text).toContain('t:project Haus Anna')
    expect(pdf.text).toContain('t:reportCover.analysisId run_7')
    expect(pdf.text).not.toContain('t:reportCover.bundesland')
  })

  /**
   * An empty run still produces a document, and the document still carries the
   * marking and the identity. „Nothing to report" filed as a blank page is the
   * one outcome a reader cannot interpret.
   */
  it('files a marked, identified document for a report with no words in it', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: '' })
    const pdf = await readPdf((await runRenderer()).bytes)

    // Two pages, and that is the document now: a cover sheet and the body. It
    // used to be one because the report was rendered onto a bare page.
    expect(pdf.pageCount).toBe(2)
    expect(pdf.text).toContain(normalizePdfText('KI-generiert — nicht geprüft'))
    expect(pdf.text).toContain('t:documentTitle')
    expect(pdf.text).toContain('t:reportCover.analysisId run_7')
  })

  describe('the legal basis', () => {
    const CARDS = [
      { type: 'summary', content: 'Die Fluchtwege sind zu prüfen.' },
      {
        type: 'legal_basis',
        law: 'OIB-Richtlinie 2',
        article: '§ 3',
        original_text: 'Fluchtwege sind so auszubilden, dass sie im Brandfall sicher benützbar sind.',
      },
    ]

    /**
     * The content ask of roadmap #3, in the artifact: the cited Richtlinie, the
     * §, and the excerpt — after the report, under a heading of their own.
     */
    it('appends the cited Richtlinie, § and excerpt as their own section', async () => {
      await fileResearchReport({
        session: SESSION,
        projectId: 'proj-1',
        runId: 'run_7',
        report: REPORT,
        cards: CARDS,
      })
      const pdf = await readPdf((await runRenderer()).bytes)

      // develop's card walker names these in the reader's own German — the same
      // walker and the same words the .docx export uses, which is the point: two
      // documents an architect puts side by side share one vocabulary.
      expect(pdf.text).toContain(
        normalizePdfText(
          'Rechtsgrundlage Gesetz / Richtlinie OIB-Richtlinie 2 Paragraf § 3 ' +
            'Originalwortlaut Fluchtwege sind so auszubilden, dass sie im Brandfall sicher benützbar sind.'
        )
      )
      // After the report's own words, never in front of them.
      expect(pdf.text.indexOf('Der Bericht beginnt hier.')).toBeLessThan(
        pdf.text.indexOf('Rechtsgrundlage')
      )
    })

    /**
     * The report's own „Quellen" section is the writer agent's text, normalised
     * by `citation_verification.sanitize_report` — heading spelling, one source
     * per line, renumbering, unsafe URLs removed. The export does not re-render
     * it, does not move it and does not add a second one: it appends after it.
     */
    it('leaves the report’s sanitized Quellen section exactly where it is', async () => {
      const report =
        '# Brandschutz Straßenhäuser\n\nDer Bericht beginnt hier.\n\n' +
        '## Quellen\n\n[1] [OIB] OIB-Richtlinie 2, Ausgabe Mai 2023\n'
      await fileResearchReport({
        session: SESSION,
        projectId: 'proj-1',
        runId: 'run_7',
        report,
        cards: CARDS,
      })
      const pdf = await readPdf((await runRenderer()).bytes)

      // ONE Quellen section, still carrying the sanitizer's origin tokens.
      //
      // Where it sits changed: `splitProse` lifts the report's own written
      // sources out of the prose and renders them as the document's reference
      // list, so they end the document rather than sitting mid-body with the
      // cards appended after. The thing this test was written to protect is
      // unchanged and is what is asserted — the section is not duplicated, and
      // the `[OIB]` / `[KB]` / `[Web]` / `[RIS]` tokens the backend's
      // `citation_verification.sanitize_report` put there survive the round
      // trip, which is what a second hand-rolled parser would have lost.
      expect(pdf.text.match(/Quellen/g)).toHaveLength(1)
      expect(pdf.text).toContain(normalizePdfText('Quellen 1 [OIB] OIB-Richtlinie 2, Ausgabe Mai 2023'))
      expect(pdf.text.indexOf('Der Bericht beginnt hier.')).toBeLessThan(
        pdf.text.indexOf('Quellen')
      )
    })

    /**
     * Today's only caller has no cards to pass — `JobReportResponse` carries
     * `report` and nothing else — so this is the shape that actually ships, and
     * it must print no heading standing over nothing.
     */
    it('prints no section at all when the run produced no legal_basis card', async () => {
      await fileResearchReport({
        session: SESSION,
        projectId: 'proj-1',
        runId: 'run_7',
        report: REPORT,
      })
      const pdf = await readPdf((await runRenderer()).bytes)

      expect(pdf.text).not.toContain('t:legalBasis')
      expect(pdf.text.endsWith('Der Bericht beginnt hier.')).toBe(true)
    })
  })

  /**
   * A report too long to render is a filing that does not happen, and this is
   * the assertion that says so from the producer's side.
   *
   * The refusal is the renderer's (`MAX_MARKDOWN_PDF_CHARS`) and this module
   * does not catch it, so what the project ends up with is nothing at all:
   * `fileGeneratedDocument` calls `render` before it creates the folder, PUTs
   * the object or inserts the row, so a throwing renderer leaves no half-filed
   * document and no empty „Berichte" behind — its own header says that is why
   * the ordering is what it is.
   *
   * What the READER ends up with is the report itself, unaffected: it is a chat
   * answer first and a document second, and `fileReportIfCommissioned` swallows
   * this exactly as it swallows a quota refusal. They are not told why the file
   * is missing, which is a gap the success banner owes rather than one this
   * module can close.
   */
  it('refuses a report the renderer will not accept, and files nothing', async () => {
    const body = 'Die Fluchtwegbreite betraegt 1,20 m. '.repeat(
      Math.ceil((MAX_MARKDOWN_PDF_CHARS + 1) / 37)
    )
    await fileResearchReport({
      session: SESSION,
      projectId: 'proj-1',
      runId: 'run_7',
      // The H1 is split off before the render, so the bound applies to the BODY
      // — the thing that is actually laid out — and a title cannot spend it.
      report: `# Brandschutz\n\n${body}`,
    })

    await expect(runRenderer()).rejects.toThrow(MarkdownTooLongError)
  })

  it('renders nothing until the service asks for it', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    expect(renderMarkdownPdf).not.toHaveBeenCalled()
    // Not even the project read, which is inside the renderer for the same
    // reason: a filing the service refuses must cost no query.
    expect(findProjectInOrg).not.toHaveBeenCalled()
  })
})
