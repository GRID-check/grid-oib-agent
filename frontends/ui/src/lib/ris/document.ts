/**
 * A RIS document's text, read through the agent's own RIS client.
 *
 * The Austrian RIS is the one source Piloti grounds on and could not SHOW.
 * A RIS citation carries an `https://www.ris.bka.gv.at/…` URL, so clicking it
 * left the product — no passage rail, no Fundstelle mark, no copy-as-Zitat, and
 * for a reader checking a legal claim that is the whole apparatus gone (#622).
 *
 * The bytes are not fetched here. `GET /v1/ris/document` on the agent returns
 * exactly what `ris_fetch_document` reads, with the same host allow-list, the
 * same size ceiling and the same shared cache — so a document the answer was
 * grounded on is usually served from that cache rather than re-fetched from
 * RIS. Re-implementing the fetch in this tier would be a second set of
 * extraction rules to keep in step with the first, on a source whose whole
 * value is that the text is verbatim.
 */

import 'server-only'
import { isTokenSafeDestination } from '@/lib/model-config/backend-defaults'

export interface RisDocument {
  /** The URL the text was read from — the canonical RIS page for the citation. */
  url: string
  title: string
  text: string
  /** True when the backend clipped the text at its reader-facing ceiling. */
  truncated: boolean
}

/**
 * Bound on the round trip.
 *
 * RIS is a third party and a consolidated Bauordnung is a large page, so this
 * is generous — but it is a reader waiting on a dialog, and a request with no
 * ceiling is a dialog that spins until the tab is closed.
 */
const RIS_FETCH_TIMEOUT_MS = 20_000

/** Raised for a refusal the CALLER can act on (bad reference, non-RIS host). */
export class RisDocumentUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'RisDocumentUnavailableError'
  }
}

export async function fetchRisDocument(
  reference: string,
  application?: string
): Promise<RisDocument> {
  const base = (process.env.BACKEND_URL ?? 'http://localhost:8000').replace(/\/$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = process.env.GRID_INTERNAL_API_TOKEN
  // Same rule as every other internal call from this tier: the shared token
  // travels over TLS, or over plain HTTP only to a destination that cannot
  // leave the deployment's own network.
  if (token && isTokenSafeDestination(base)) {
    headers['x-grid-internal-token'] = token
  }

  const params = new URLSearchParams({ reference })
  if (application) params.set('application', application)

  const response = await fetch(`${base}/v1/ris/document?${params.toString()}`, {
    headers,
    cache: 'no-store',
    // A redirect would replay the internal token at whatever host the response
    // names. The internal endpoint never redirects.
    redirect: 'error',
    signal: AbortSignal.timeout(RIS_FETCH_TIMEOUT_MS),
  })

  if (response.status === 400) {
    // The backend's 400s are all statements about the reference — a non-RIS
    // host, a PDF-only document, an unparseable document number. They are the
    // reader's answer ("this source cannot be shown here"), not an outage.
    throw new RisDocumentUnavailableError('This RIS reference cannot be read', 404)
  }
  if (!response.ok) {
    throw new RisDocumentUnavailableError('RIS is not reachable right now', 502)
  }

  const body = (await response.json()) as Partial<RisDocument>
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    throw new RisDocumentUnavailableError('This RIS reference cannot be read', 404)
  }
  return {
    url: typeof body.url === 'string' && body.url ? body.url : reference,
    title: typeof body.title === 'string' ? body.title : '',
    text: body.text,
    truncated: body.truncated === true,
  }
}
