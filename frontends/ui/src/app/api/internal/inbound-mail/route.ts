/**
 * INTERNAL endpoint — the Cloudflare Email Worker delivers one raw message
 * (ADR-0074).
 *
 * The Worker does not parse: it streams `message.raw` here with the envelope
 * recipient in `x-envelope-to`, and maps the answer to accept (2xx), reject
 * (403, 404, 413 — one generic bounce text for all three) or retry (429, 409,
 * 5xx). Its credential is `GRID_INBOUND_MAIL_TOKEN`, not the service token: it
 * lives outside the cluster, and leaking it opens this route and no other.
 *
 * ONE cross-tenant step. The token in the recipient address names the project
 * before any organization is known, so that lookup runs under the platform
 * bypass and returns three ids and nothing else. Everything after it — the
 * sender's membership, the permission, the filing — happens inside that one
 * organization, so row-level security still applies to all of it.
 */

import { NotFoundError } from '@/lib/api/errors'
import { internalApiRoute } from '@/lib/api/handler'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { findActiveAddressByToken } from '@/lib/inbound-mail/repository'
import { readRawMessage, receiveInboundMail, tokenForRecipient } from '@/lib/inbound-mail/service'

export const POST = internalApiRoute(
  'Inbound Mail',
  async ({ request }) => {
    const token = tokenForRecipient(request.headers.get('x-envelope-to'))
    const raw = await readRawMessage(request)

    const address = await withPlatformAccess(
      'inbound mail: the address token names the project before any organization is known',
      () => findActiveAddressByToken(token)
    )
    if (!address) throw new NotFoundError('Unknown address')

    return withTenant({ organizationId: address.organizationId }, () =>
      receiveInboundMail(address, raw, request)
    )
  },
  {
    tenancy: { fromPayload: 'the project address the x-envelope-to token resolves to' },
    tokenEnv: 'GRID_INBOUND_MAIL_TOKEN',
  }
)
