/**
 * The first caller of `fileGeneratedDocument`: a finished deep-research run.
 *
 * A separate module from the jobs proxy for the reason every other route in
 * this app has one — a route handler validates a request shape and delegates —
 * and for one specific to this path: what a research report LOOKS like (its
 * title, its renderer, its marking) is a product decision that will change
 * without the proxy changing, and the next producer must be able to arrive as a
 * sibling of this file rather than as another branch inside the proxy.
 *
 * It owns exactly two things the service deliberately does not:
 *
 *   - the renderer. `@/lib/pdf` already turns Markdown into a PDF, so a
 *     research report is that pipeline with the two provenance options turned
 *     on — never a second exporter.
 *   - the title, which is read out of the report the writer agent produced
 *     rather than invented here.
 *
 * ## Why the filed report is a PDF and the saved-answer export is a .docx
 *
 * They are different documents with different jobs, and the format follows the
 * job. A saved answer is exported so somebody can EDIT it — paste it into a
 * Befund, revise it, sign it — and `answer-export/docx.ts` says so in its own
 * header. A filed report is exported so somebody can READ it in the app and
 * ATTACH it to an Einreichung, and both of those want a PDF:
 *
 *   - `PREVIEW_TYPES` in `features/documents/components/file-preview-pane.tsx`
 *     lists the content types the Files pane can render. `.docx` is not one of
 *     them, so the report a user had just commissioned landed in Berichte as a
 *     generic icon with no in-app preview — download-only, for the one document
 *     in the project nobody had read yet;
 *   - an Einreichung attachment is a PDF. Handing the Behörde an editable Word
 *     file is not the form the artifact takes at the end of this flow.
 *
 * The `.docx` export path for saved answers is untouched and stays. This is a
 * new renderer at an existing seam — `fileGeneratedDocument` takes the render
 * function precisely so a new output format is not a new pipeline.
 */

import 'server-only'
import { getLocale, getTranslations } from '@/i18n/server'
import type { Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/translate'
import { PDF_MEDIA_TYPE, renderMarkdownPdf } from '@/lib/pdf/markdown-pdf'
import type { AuthorizedSession } from '@/lib/auth/types'
import { fileGeneratedDocument, type FiledGeneratedDocument } from './generated'

export interface FileResearchReportInput {
  session: AuthorizedSession
  projectId: string
  /** The backend async job id of the run. */
  runId: string
  /** The report as the writer agent wrote it: Markdown. */
  report: string
  request?: Request
}

/**
 * The report's own heading, and the body without it.
 *
 * The writer agent opens `/shared/output.md` with an H1 that names the thing it
 * researched, which is a better document title than anything this module could
 * derive — and leaving it in the body as well would print the same line twice,
 * once as the document's H1 and once as the first paragraph under it.
 *
 * When there is no leading heading the body is returned untouched and the
 * caller falls back to the export's own generic title. A title guessed from the
 * first sentence would be the export stating something the run never did.
 */
export function splitReportTitle(report: string): { title: string | null; body: string } {
  const match = /^[\s]*#\s+(.+?)\s*(?:\n|$)/.exec(report)
  if (!match) return { title: null, body: report }
  return { title: match[1].trim(), body: report.slice(match[0].length) }
}

/**
 * The header facts the .docx carried, as markdown.
 *
 * The .docx got these from `buildAnswerDocument`, which assembles OOXML blocks;
 * the PDF path is markdown in, PDF out, so the same two facts are composed here
 * instead. They are the same facts read from the same `answerExport` keys, in
 * the same locale's date format — dropping them when the format changed would
 * have quietly made the filed report say less than the file it replaced.
 *
 * `answer-document.ts`'s rule applies unchanged: **a field that has no value
 * produces no line.** A report filed from a project with no name must not print
 * „Projekt:" with nothing after it, because a reader away from the app cannot
 * tell that apart from a claim.
 */
function reportHeader(
  documentTitle: string,
  projectName: string | undefined,
  createdAt: Date,
  t: Translator,
  locale: Locale
): string {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(createdAt)
  const lines = [`# ${documentTitle}`]
  if (projectName?.trim()) lines.push(`**${t('project')}:** ${projectName.trim()}`)
  lines.push(`**${t('createdAt')}:** ${date}`)
  // Blank-line separated so each is its own markdown paragraph. Joined with
  // single newlines they are one paragraph to `marked`, and the two facts run
  // together on one line in the PDF.
  return lines.join('\n\n')
}

/**
 * Render a finished run's report and file it into the project.
 *
 * Both provenance options are set HERE, and they are independent by design: the
 * printed *"KI-generiert — nicht geprüft"* block on page one (`notice`) is what
 * a person reads, and the document metadata (`aiProvenance`) is what a records
 * system detects without OCR. A caller that sets one and not the other ships a
 * document that is marked for exactly one of its two audiences — so this caller
 * owns passing both, and this is the comment that says so.
 *
 * The notice's words come from `answerExport.aiNotice.*` — the SAME keys the
 * .docx export reads. There is one German sentence saying this and one English
 * one, and a format that spelled out its own copy would be a second sentence
 * with the same job, drifting from the first with nothing to catch it.
 */
export async function fileResearchReport(
  input: FileResearchReportInput,
): Promise<FiledGeneratedDocument> {
  const { session, projectId, runId, report, request } = input
  const { title, body } = splitReportTitle(report)
  const [t, locale] = await Promise.all([getTranslations('answerExport'), getLocale()])
  const documentTitle = title ?? t('documentTitle')

  return fileGeneratedDocument({
    session,
    projectId,
    producer: 'deep_research',
    runId,
    title: documentTitle,
    request,
    render: async ({ projectName }) => {
      const header = reportHeader(
        documentTitle,
        projectName,
        // The instant the report is filed. Unlike a saved answer — which has
        // its own older `createdAt` and must not be re-dated by a download —
        // this document comes into existence now, and the run that produced
        // it finished moments ago.
        new Date(),
        t,
        locale
      )
      const bytes = await renderMarkdownPdf(`${header}\n\n${body}`, {
        title: documentTitle,
        notice: { title: t('aiNotice.title'), body: t('aiNotice.body') },
        aiProvenance: { runId },
      })
      return { bytes, contentType: PDF_MEDIA_TYPE }
    },
  })
}
