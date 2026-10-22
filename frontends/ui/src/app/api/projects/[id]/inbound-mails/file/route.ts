/**
 * Decide held mail (ADR-0134, D26): file the named parts of up to 20 mails;
 * every other waiting part of each is dismissed.
 *
 * POST — checks every rule of DECISION §4 C2 for every mail (a refusal names
 *        its code in `details.reason`), then writes the decisions, claims the
 *        parts and queues the filing job in one transaction, compare-and-set
 *        against the `ifMatch` each mail was read at. Answers 202 with the
 *        mails as they stand; the job files each part as the caller.
 *        Acknowledgements only in a request about one mail.
 *
 * Who: `project:documents:write`, and write on every target folder. An outside
 * agent's call runs only on the person's own yes (`requiresPersonConfirmation`),
 * and Piloti only proposes it as a card.
 *
 * Thin handler; the logic is `@/lib/inbound-mail/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { fileInboundMailsBodySchema } from '@/lib/inbound-mail/inbound-mail-wire'
import { fileInboundMails } from '@/lib/inbound-mail/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => fileInboundMails(session, params.id, await parseJsonBody(request, fileInboundMailsBodySchema)),
  {
    authz: {
      enforcedBy:
        'fileInboundMails -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit) ' +
        'and requireDecisionRights (requireFolderWrite on every target folder)',
    },
    status: 202,
  },
)
