/**
 * Take one filed message out of its mail thread (ADR-0134, D34).
 *
 * POST — moves the message into another thread (`target.action: 'append'`) or a
 *        new one (`'create'`): the thread it leaves gets a new Fassung without
 *        it (earlier Fassungen keep it), the thread it joins a new Fassung with
 *        it, and every follow of the thread it left ends. 409 with
 *        `details.reason` (`MAIL_THREAD_REFUSALS`) for a message that is its
 *        thread's only one, a busy thread, a target that is unknown, full or
 *        a name that is stopped or taken.
 *
 * Thin handler; the logic is `@/lib/mail-thread/detach`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { detachMailThreadEntry } from '@/lib/mail-thread/detach'
import { mailThreadEntryDetachBodySchema } from '@/lib/mail-thread/mail-thread-wire'

type Params = { id: string; threadId: string; entryId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, mailThreadEntryDetachBodySchema)
    return detachMailThreadEntry(session, params.id, params.threadId, params.entryId, body, request)
  },
  {
    authz: {
      enforcedBy:
        'detachMailThreadEntry -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit) + requireFolderWrite on both thread documents’ folders',
    },
  }
)
