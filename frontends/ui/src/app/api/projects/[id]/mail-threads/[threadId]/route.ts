/**
 * One mail thread (ADR-0134, D36).
 *
 * GET — its filed messages in order (heading, sender and trust, sent and
 *       received, the Fassung each first appeared in, whether its original is
 *       kept), each message's attachments with what became of them, its
 *       follows, and, for whoever may file mail, how many mails wait that
 *       matched it. As readable as its document; 404 otherwise.
 *
 * Thin handler; the logic is `@/lib/mail-thread/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getMailThread } from '@/lib/mail-thread/service'

type Params = { id: string; threadId: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getMailThread(session, params.id, params.threadId), {
  authz: { enforcedBy: 'getMailThread (inbound-mail entitlement; project:view; the thread document screened and in a folder the caller sees)' },
})
