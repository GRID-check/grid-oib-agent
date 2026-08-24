/**
 * One saved answer, as a downloadable Word document.
 *
 * A GET, deliberately — the same reasoning as the BCF export in
 * `projects/[id]/bim/checks/export`: the browser's own download path handles
 * the file, nothing here writes, and the URL is something an architect can
 * bookmark or paste to a colleague, whose own session then decides whether they
 * may have it.
 *
 * Thin handler; the tenancy check, the document and the file name all live in
 * `@/lib/answer-export/service`.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { exportAnswerDocument } from '@/lib/answer-export/service'

type Params = { id: string; messageId: string }

/** `messages.id` is a uuid column — a malformed id must 400, not blow up in SQL. */
const messageIdSchema = z.string().uuid()

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const messageId = messageIdSchema.safeParse(params.messageId)
    if (!messageId.success) throw new BadRequestError('Invalid message id')

    const document = await exportAnswerDocument(session, params.id, messageId.data)

    return new NextResponse(new Uint8Array(document.bytes), {
      status: 200,
      headers: {
        'Content-Type': document.mediaType,
        'Content-Disposition': `attachment; filename="${document.filename}"`,
        // The answer can be edited (a card answered, provenance recorded) after
        // this file was built, so a cached copy would hand a colleague a
        // document that disagrees with the thread it came from.
        'Cache-Control': 'no-store',
      },
    })
  },
  { authz: { enforcedBy: 'exportAnswerDocument (requireResourceAccess on the conversation)' } }
)
