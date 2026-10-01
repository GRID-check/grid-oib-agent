/**
 * INTERNAL endpoint — the Cloudflare Email Worker delivers one raw message
 * (ADR-0075).
 *
 * The Worker does not parse: it streams `message.raw` here with the envelope
 * recipient in `x-envelope-to` and the size in `x-inbound-raw-size`. The
 * answer is 202 (queued) or 200 (a duplicate), a permanent refusal marked
 * `x-inbound-verdict: reject` (the only answer the Worker bounces), or anything
 * else, which the Worker turns into a retry. Its credential is
 * `GRID_INBOUND_MAIL_TOKEN`, not the service token: it lives outside the
 * cluster, and leaking it opens this route and no other.
 *
 * ONE cross-tenant step, taken inside the service: the token in the recipient
 * address names the project before any organization is known, so that lookup
 * alone runs under the platform bypass and returns three ids. Everything after
 * it happens inside that one organization. The order of work, and why:
 * `@/lib/inbound-mail/receive`.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { receiveInboundMail } from '@/lib/inbound-mail/receive'

export const POST = internalApiRoute('Inbound Mail', ({ request }) => receiveInboundMail(request), {
  tenancy: { fromPayload: 'the project address the x-envelope-to token resolves to' },
  tokenEnv: 'GRID_INBOUND_MAIL_TOKEN',
})
