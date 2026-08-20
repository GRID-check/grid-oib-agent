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
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import type { AuthorizedSession } from '@/lib/auth/types'
import { readPdf } from '@/test-utils/read-pdf'
import type { GeneratedRenderContext } from './generated'
import { fileResearchReport, splitReportTitle } from './research-report'

const SESSION = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession

const REPORT = '# Brandschutz Straßenhäuser\n\nDer Bericht beginnt hier.\n'

/** Run the renderer the caller handed to the service. */
const runRenderer = () => {
  const input = fileGeneratedDocument.mock.calls[0][0]
  const context: GeneratedRenderContext = { projectId: 'proj-1', projectName: 'Haus Anna' }
  return input.render(context)
}

beforeEach(() => {
  vi.clearAllMocks()
  fileGeneratedDocument.mockResolvedValue({
    documentId: 'doc-1',
    filename: 'brandschutz-2026-08-20.pdf',
    folderId: 'folder-1',
    alreadyFiled: false,
  })
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
    expect(input.runId).toBe('run_7')
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
    const pdf = await readPdf((await runRenderer()).bytes)

    // The translator is stubbed as `t:<key>`, so this asserts the exact i18n
    // keys the .docx export already uses reached the page — a renderer that
    // wrote its own second copy of the sentence would not contain these.
    expect(pdf.text).toContain('t:aiNotice.title')
    expect(pdf.text).toContain('t:aiNotice.body')

    expect(pdf.info.Keywords).toBe(
      'AIGenerated=true; AIGenerator=Piloti; AIHumanReviewed=false; AIRunId=run_7'
    )
    expect(pdf.info.Creator).toBe('Piloti')
  })

  /**
   * The header facts the .docx carried. Dropping them when the format changed
   * would have quietly made the filed report say less than the file it replaced
   * — and the project name is the one fact a reader cannot recover from a page
   * that has left the app.
   */
  it('keeps the report’s title, the project and the date on the page', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const pdf = await readPdf((await runRenderer()).bytes)

    expect(pdf.text).toContain('Brandschutz Straßenhäuser')
    expect(pdf.text).toContain('t:project: Haus Anna')
    expect(pdf.text).toContain('t:createdAt:')
    expect(pdf.text).toContain('Der Bericht beginnt hier.')
    expect(pdf.info.Title).toBe('Brandschutz Straßenhäuser')
  })

  it('renders nothing until the service asks for it', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    expect(renderMarkdownPdf).not.toHaveBeenCalled()
  })
})
