/**
 * Filing a diagram the browser drew.
 *
 * Thin, like every other route here: the authorization lives in
 * `fileGeneratedDocument` (`project:documents:write`), the validation lives in
 * `lib/diagrams/svg.ts`, and this handler only turns a request into those two
 * calls and a refusal into a message a person can read.
 *
 * The one thing that is genuinely this layer's business is the LOCALE. The PDF
 * carries a provenance line, and that line is part of the artifact rather than
 * part of the chrome — so it has to be resolved where the request is, from the
 * cookie the reader set, and handed down. A renderer that reached for a
 * dictionary itself would print one language for every office.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { getDictionary } from '@/i18n/dictionaries'
import { getLocale } from '@/i18n/server'
import { DIAGRAM_SOURCE_KINDS } from '@/lib/diagrams/diagram-sources'
import { DiagramSvgError } from '@/lib/diagrams/svg'
import { fileDiagramDocuments } from '@/lib/diagrams/filing'

type Params = { id: string }

const fileDiagramSchema = z.object({
  /**
   * The chat message the diagram was drawn in. It is `authored_by_run_id` and
   * half the idempotency key (migration 0065), so pressing the button twice on
   * one message files nothing twice.
   */
  runId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  sourceKind: z.enum(DIAGRAM_SOURCE_KINDS),
  source: z.string().min(1),
  svg: z.string().min(1),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, fileDiagramSchema)
    const dictionary = getDictionary(await getLocale())

    try {
      const filed = await fileDiagramDocuments({
        session,
        projectId: params.id,
        runId: body.runId,
        title: body.title,
        sourceKind: body.sourceKind,
        source: body.source,
        svg: body.svg,
        marking: dictionary.diagrams.marking,
        request,
      })
      return { svg: filed.svg, pdf: filed.pdf }
    } catch (error) {
      // A refusal is the client's fault and the client can fix it — a renderer
      // configured with `htmlLabels` on, a stylesheet it forgot to flatten. A
      // 500 would tell it to retry the same bytes forever, so the rejection is
      // mapped to a 400 that names the rule in the reader's language.
      if (error instanceof DiagramSvgError) {
        throw new BadRequestError(dictionary.diagrams.rejected[error.rejection])
      }
      throw error
    }
  },
  {
    status: 201,
    authz: {
      enforcedBy:
        'fileDiagramDocuments → fileGeneratedDocument (requireProjectAccess project:documents:write)',
    },
  }
)
