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
 *   - the renderer. `answer-export` already turns Markdown + citations into an
 *     authorized `.docx`, so a research report is that pipeline with the two
 *     provenance options turned on — never a second exporter.
 *   - the title, which is read out of the report the writer agent produced
 *     rather than invented here.
 */

import 'server-only'
import { buildAnswerDocument } from '@/lib/answer-export/answer-document'
import { DOCX_MEDIA_TYPE, renderDocx } from '@/lib/answer-export/docx'
import { getLocale, getTranslations } from '@/i18n/server'
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
 * Render a finished run's report and file it into the project.
 *
 * Both provenance options are set HERE, and they are independent by design: the
 * printed *"KI-generiert — nicht geprüft"* block on page one
 * (`agentAuthored`) is what a person reads, and the `docProps` custom property
 * (`aiProvenance`) is what a records system detects without OCR. A caller that
 * sets one and not the other ships a document that is marked for exactly one of
 * its two audiences — so this caller owns passing both, and this is the comment
 * that says so.
 */
export async function fileResearchReport(
  input: FileResearchReportInput,
): Promise<FiledGeneratedDocument> {
  const { session, projectId, runId, report, request } = input
  const { title, body } = splitReportTitle(report)
  const [t, locale] = await Promise.all([getTranslations('answerExport'), getLocale()])

  return fileGeneratedDocument({
    session,
    projectId,
    producer: 'deep_research',
    runId,
    title: title ?? t('documentTitle'),
    request,
    render: ({ projectName }) => {
      const blocks = buildAnswerDocument(
        {
          conversationTitle: title,
          projectName,
          answer: body,
          // The instant the report is filed. Unlike a saved answer — which has
          // its own older `createdAt` and must not be re-dated by a download —
          // this document comes into existence now, and the run that produced
          // it finished moments ago.
          createdAt: new Date(),
          agentAuthored: true,
        },
        t,
        locale,
      )
      return { bytes: renderDocx(blocks, { aiProvenance: { runId } }), contentType: DOCX_MEDIA_TYPE }
    },
  })
}
