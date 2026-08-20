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
import { BadRequestError, PayloadTooLargeError } from '@/lib/api/errors'
import { getDictionary } from '@/i18n/dictionaries'
import { getLocale } from '@/i18n/server'
import {
  DIAGRAM_SOURCE_KINDS,
  MAX_DIAGRAM_SOURCE_BYTES,
  MAX_DIAGRAM_SVG_BYTES,
} from '@/lib/diagrams/diagram-sources'
import { DiagramSvgError } from '@/lib/diagrams/svg'
import { fileDiagramDocuments } from '@/lib/diagrams/filing'

type Params = { id: string }

/**
 * The largest JSON body this route will read.
 *
 * `parseDiagramSvg` and `acceptDiagram` cap the SVG and the source — but they
 * cap them AFTER `request.json()` has buffered the whole body, and an App
 * Router handler has no body limit of its own: `next.config`'s `bodySizeLimit`
 * governs Server Actions only, so the transport ceiling is the 250 MB one sized
 * for `.ifc` uploads. Without this, the two caps described in
 * `docs/api/bff-routes.md` were enforced on a payload the process had already
 * held in memory.
 *
 * The number is the two caps plus 100%, plus 8 KiB for `runId`, `title`,
 * `sourceKind` and the JSON scaffolding. The doubling is JSON escaping: every
 * `"` in an SVG attribute arrives as `\"`, and a diagram is mostly attributes.
 * It is not a tight bound and must not be — it exists to stop a body nothing
 * downstream could accept anyway, and the exact refusals stay where they can
 * name their rule. (`JSON.stringify` escapes a control character as `\uXXXX`,
 * six bytes for one, so an SVG made of those would be refused here rather than
 * by the validator — a file that is 1 MiB of U+0001 is not a diagram, and 413
 * is a true statement about it.)
 */
const MAX_DIAGRAM_REQUEST_BYTES = 2 * (MAX_DIAGRAM_SVG_BYTES + MAX_DIAGRAM_SOURCE_BYTES) + 8 * 1024

const fileDiagramSchema = z.object({
  /**
   * The chat message the diagram was drawn in. It is `authored_by_run_id` and
   * half the idempotency key (migration 0065), so pressing the button twice on
   * one message files nothing twice.
   */
  runId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  sourceKind: z.enum(DIAGRAM_SOURCE_KINDS),
  /**
   * Bounded here as well as in `acceptDiagram`, and by the LARGEST kind's cap:
   * this schema does not know which kind is in the same body, so the per-kind
   * cap (32 KiB mermaid, 512 KiB excalidraw) stays where the kind is known and
   * this one only keeps an unbounded string out of the validator.
   *
   * The caps count bytes and `.max()` counts UTF-16 code units, which is safe
   * in this direction only: a code unit is never fewer than one UTF-8 byte, so
   * a string this admits can still be refused for its byte length, and one it
   * refuses could never have passed the byte check.
   */
  source: z.string().min(1).max(MAX_DIAGRAM_SOURCE_BYTES),
  svg: z.string().min(1).max(MAX_DIAGRAM_SVG_BYTES),
})

/**
 * Refuse a body that says up front it is too big, before it is buffered.
 *
 * `Content-Length` is a claim, not a fact, so this is the cheap half: a client
 * that omits it or lies is still bounded by the `.max()` on the fields, one
 * step later and one buffer more expensive. Both are needed — the header check
 * is the only one that runs before the bytes are read, and the schema is the
 * only one that holds when there is no header.
 */
function refuseOversizedBody(request: Request): void {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DIAGRAM_REQUEST_BYTES) {
    throw new PayloadTooLargeError(MAX_DIAGRAM_REQUEST_BYTES)
  }
}

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    refuseOversizedBody(request)
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
      // `pdf` is null when only the SVG landed, and the status stays 201: a
      // document WAS created, is quota-charged and is visible in Berichte, so
      // any 4xx/5xx here would be a false statement about the project. The body
      // is what says which halves exist; the client turns the null into the one
      // sentence that is true and the button that files the missing half.
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
