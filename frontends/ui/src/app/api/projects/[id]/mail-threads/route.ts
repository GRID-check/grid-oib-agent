/**
 * The project's mail threads (ADR-0134): each conversation filed as one
 * document.
 *
 * GET — one page, newest first, `documentId` for the thread of one document.
 *       Only threads whose document the caller may read: screened, not in the
 *       bin, in a folder they may open (`project:view` and the folder rule).
 *
 * Thin handler; the logic is `@/lib/mail-thread/service`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { mailThreadListQuerySchema } from '@/lib/mail-thread/mail-thread-wire'
import { listMailThreads } from '@/lib/mail-thread/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => listMailThreads(session, params.id, parseQuery(request, mailThreadListQuerySchema)),
  { authz: { enforcedBy: 'listMailThreads (inbound-mail entitlement; project:view; each thread document screened and in a folder the caller sees)' } },
)
