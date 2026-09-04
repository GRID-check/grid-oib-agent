/**
 * RIS document text — so a RIS citation opens inside Piloti (#622).
 *
 * Thin handler; the fetch and every rule about it live in `@/lib/ris/document`.
 *
 * ## Why `sessionOnly`
 *
 * The Austrian RIS is public law, published by the Bundeskanzleramt for anyone
 * to read: the bytes this returns are the bytes at the URL the citation already
 * shows, and there is no tenant resource to authorize against. What the gate
 * has to prevent is this origin becoming a free fetcher for the internet, which
 * authentication does — and the reference is confined to RIS hosts by the
 * backend client's allow-list, on the far side of the internal token, so a
 * caller cannot aim it at anything else. The rate limit is the factory's
 * `DEFAULT_READ_LIMIT`, declared by omission.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { NotFoundError, UpstreamError } from '@/lib/api/errors'
import { fetchRisDocument, RisDocumentUnavailableError } from '@/lib/ris/document'

const risDocumentQuerySchema = z.object({
  /**
   * A RIS document number (`NOR40217157`) or a `https://www.ris.bka.gv.at/…`
   * URL. Both are accepted because both are what a citation can carry: the
   * norm registry stores document numbers, and a retrieved hit carries the URL.
   */
  reference: z.string().min(1).max(2048),
  /** RIS application code, when a bare document number needs disambiguating. */
  application: z.string().max(32).optional(),
})

export const GET = apiRoute(
  async ({ request }) => {
    const { reference, application } = parseQuery(request, risDocumentQuerySchema)
    try {
      return await fetchRisDocument(reference, application)
    } catch (error) {
      if (error instanceof RisDocumentUnavailableError) {
        // 404 is the honest answer for a reference RIS will not serve as text
        // — the viewer then keeps offering the outbound link, which is what the
        // reader can still use.
        if (error.status === 404) throw new NotFoundError(error.message)
        throw new UpstreamError(error.message)
      }
      throw new UpstreamError('RIS is not reachable right now')
    }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'reads a public RIS page through the agent’s host-allow-listed client — no tenant resource to authorize against, only an origin that must not be a free fetcher for the internet',
    },
  }
)
