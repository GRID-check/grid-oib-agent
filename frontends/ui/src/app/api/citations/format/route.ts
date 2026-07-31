/**
 * Citation formatting API — renders the CSL-JSON of an answer's sources into
 * BibTeX / RIS (.ris) / a formatted APA bibliography.
 *
 * Server-side because citation-js is a Node library (its core reaches for
 * `node:fs` and cannot be bundled for the browser). The request carries only
 * the CSL-JSON the client already holds; nothing is read from the database, so
 * this is a pure formatting endpoint behind the normal session guard.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { renderCitations } from '@/lib/citations/render'

/** Guard rails: an answer cites a handful of sources, never hundreds. */
const MAX_ITEMS = 64

const formatRequestSchema = z.object({
  format: z.enum(['apa', 'bibtex', 'ris']),
  items: z.array(z.record(z.unknown())).max(MAX_ITEMS),
})

export const POST = apiRoute(
  async ({ request }) => {
    const { format, items } = await parseJsonBody(request, formatRequestSchema)
    return { text: await renderCitations(items, format) }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'pure formatting of citation text supplied in the request body; reads no stored data',
    },
  }
)
