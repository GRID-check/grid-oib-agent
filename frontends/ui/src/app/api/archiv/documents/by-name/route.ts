/**
 * Archiv API — the Archiv documents with these filenames, as listing rows.
 *
 * The Archiv half of the by-name resolve (`POST /api/documents/by-name`;
 * `lib/documents/by-name-types.ts` is the shared contract). Feature-gated like
 * the listing (ADR-0024). Thin handler; all logic lives in `@/lib/archiv/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { resolveArchivDocumentsByName } from '@/lib/archiv/service'
import { toDocumentWireRows } from '@/lib/documents/list-projection'
import { archivByNameRequestSchema } from '@/lib/documents/by-name-types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.orgArchiv)
    if (gated) return gated
    const { names } = await parseJsonBody(request, archivByNameRequestSchema)
    const documents = await resolveArchivDocumentsByName(session, names)
    // The same row the listing serves, version summary included, so a resolved
    // document and a listed one cannot render differently.
    return { documents: await toDocumentWireRows(session.organizationId, documents) }
  },
  {
    authz: {
      sessionOnly: true,
      why: "read-only lookup of the caller's own org Archiv by filename; scoped by session.organizationId, the same rows listArchiv already shows any member",
    },
  }
)
