/**
 * The Prüfbuch as a BCF 2.1 archive.
 *
 * A GET rather than a POST, and deliberately: the browser's own download path
 * handles the file, the URL is something an architect can bookmark or paste to
 * a colleague, and nothing here writes. The facts arrive as query parameters
 * for the same reason — the export must be reproducible from its URL, and a
 * body is not part of one.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { exportAccessibleComplianceBcf } from '@/lib/bim/model-service'
import { BIM_HAUPTNUTZUNG } from '@/lib/bim/query'

type Params = { id: string }

/**
 * The same coercion the panel applies before it runs the catalogue: a fact
 * that will not parse arrives as `null` so the rules that need it stand down
 * with a reason, rather than running against a guessed Gebäudeklasse.
 */
const paramsSchema = z
  .object({
    modelId: z.string().uuid().optional(),
    /**
     * The model's file name, the way the rest of the app addresses one
     * (`buildModelHref`, the agent's `ifc_query`). Accepted so a link can be
     * composed in a conversation, where a UUID is a reliable source of
     * hallucinated identifiers.
     */
    model: z.string().trim().min(1).max(255).optional(),
    gebaeudeklasse: z.coerce.number().int().min(1).max(5).nullish().catch(null),
    // `.catch(null)` degrades an unrecognised use to "not stated", which the
    // catalogue reports WITH its reason — rather than to a value that makes
    // rules stand down as "not applicable", which reads as a verdict.
    hauptnutzung: z.enum(BIM_HAUPTNUTZUNG).nullish().catch(null),
  })
  .refine((value) => Boolean(value.modelId ?? value.model), {
    message: 'modelId or model is required',
  })

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = parseQuery(request, paramsSchema)

    const bcf = await exportAccessibleComplianceBcf(session, params.id, {
      modelId: input.modelId ?? null,
      modelName: input.model ?? null,
      gebaeudeklasse: input.gebaeudeklasse ?? null,
      hauptnutzung: input.hauptnutzung ?? null,
    })

    return new NextResponse(new Uint8Array(bcf.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${bcf.filename}"`,
        // The number of topics, so a caller that is not a browser can tell a
        // clean ledger from a failed export without unzipping the answer.
        'X-Grid-Bcf-Topics': String(bcf.topics),
        // Derived from a revision that can be superseded five minutes later.
        'Cache-Control': 'no-store',
      },
    })
  },
  {
    authz: {
      enforcedBy: 'exportAccessibleComplianceBcf (ifc-models flag + project:view + model tenancy)',
    },
  }
)
