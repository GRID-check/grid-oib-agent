/**
 * INTERNAL service endpoint — the office's chat screening (ADR-0079, "Chat
 * messages are screened too").
 *
 * The chat socket (`aiq_api.chat_socket`) reads it once per connection and
 * masks every question, colleague line and typed HITL answer with it before the
 * agent sees one, so a client that skipped the composer's check gets the same
 * result. `GET ?organizationId=` → `{ enabled, content_terms, detectors }`: the
 * content half of `settings.uploadScreening`, never the name terms.
 *
 * Fails CLOSED: settings that cannot be read answer with Piloti's suggested
 * list. The agent asks for the organization the BFF signed into the socket's
 * envelope; token-guarded (`internalApiRoute`), and the read runs in that
 * organization, so the token grants no cross-tenant reach.
 */

import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { chatScreeningFor } from '@/lib/upload-screening/service'

const querySchema = z.object({
  organizationId: z.string().min(1).max(128),
})

export const GET = internalApiRoute(
  'Internal Chat Screening',
  async ({ request }) => {
    const { organizationId } = parseQuery(request, querySchema)
    return withTenant({ organizationId }, () => chatScreeningFor(organizationId))
  },
  { tenancy: { fromPayload: '?organizationId' } }
)
