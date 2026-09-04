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
 * caller cannot aim it at anything else.
 *
 * It carries its OWN rate limit rather than inheriting one, because there is
 * none to inherit: `resolveLimitRule` defaults mutations and leaves reads to
 * the edge's per-IP budget. That is the right default for a read that touches a
 * database, and the wrong one for the only read here that makes a third-party
 * network call — see `RIS_DOCUMENT_LIMIT` for what one unbounded request costs.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { RIS_DOCUMENT_LIMIT } from '@/lib/limits/catalog'
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
  /**
   * The cited passage, so an over-long document is windowed AROUND it rather
   * than clipped at its head. Published law either way — this is the same text
   * the answer already shows the reader.
   */
  passage: z.string().max(2000).optional(),
})

export const GET = apiRoute(
  async ({ request }) => {
    const { reference, application, passage } = parseQuery(request, risDocumentQuerySchema)
    try {
      return await fetchRisDocument(reference, application, passage)
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
    limits: { rule: RIS_DOCUMENT_LIMIT },
    authz: {
      sessionOnly: true,
      why: 'reads a public RIS page through the agent’s host-allow-listed client — no tenant resource to authorize against, only an origin that must not be a free fetcher for the internet',
    },
  }
)
