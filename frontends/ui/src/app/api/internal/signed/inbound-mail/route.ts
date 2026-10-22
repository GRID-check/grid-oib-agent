/**
 * INTERNAL, signed: the Cloudflare Email Worker delivers one raw message
 * (ADR-0135). Not a person's route and no agent operation: the reachability
 * walk skips every `internalApiRoute`.
 *
 * POST — the body is the message as it arrived (`message/rfc822`), its length
 * and RFC 9530 digest signed with RFC 9421 together with the envelope headers
 * `x-envelope-to` and `x-envelope-from` (`shared/inbound-mail-contract.json`).
 * The answer is 202 (held for the receive job), 200 (a second delivery of a
 * mail already held), a 4xx with `x-inbound-verdict: reject` (the only answer
 * the Worker bounces: unknown address, office switched off, too large), or
 * anything else, which the Worker turns into a retry by the sending server.
 *
 * Under `/api/internal/signed/`, which the Next proxy does not match, so the
 * body reaches the route unbuffered and uncut (`signed-routes.spec.ts`). The
 * token in the recipient names the project before any organization is known,
 * so that one lookup runs under the platform bypass and the rest inside the
 * organization it resolves to. The order of work: `@/lib/inbound-mail/receive`.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { ENVELOPE_FROM_HEADER, ENVELOPE_TO_HEADER } from '@/lib/inbound-mail/contract'
import { receiveInboundMail } from '@/lib/inbound-mail/receive'

export const POST = internalApiRoute('Inbound mail', ({ request, signature }) => receiveInboundMail({ request, signature }), {
  auth: { signature: { keysEnv: 'GRID_INBOUND_MAIL_SIGNING_KEYS', components: [ENVELOPE_TO_HEADER, ENVELOPE_FROM_HEADER] } },
  tenancy: { fromPayload: 'the project address the x-envelope-to token resolves to' },
})
