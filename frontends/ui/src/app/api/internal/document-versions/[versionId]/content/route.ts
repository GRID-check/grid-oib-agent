/**
 * INTERNAL service endpoint — one document version's bytes, as text.
 *
 * ## Why this exists
 *
 * A conversation whose subject is a document is answered from the retrieval
 * index, and only a PUBLISHED version reaches that index (ADR-0054). So for a
 * draft, an in-review or a changes-requested version there are no chunks at
 * all, the focus filter matches nothing, and it falls open to the whole corpus
 * — the reader asks „warum steht in Abschnitt 3 GK 4?" about the report Piloti
 * just wrote and gets an answer sourced from everything except that report.
 *
 * The fix is upstream of the filter: the turn reads the subject version's own
 * bytes into the conversation's working directory before the graph starts.
 * That read is this route. It is the same object fetch the user-session route
 * `GET /api/documents/[id]/versions/[versionId]/content` runs, addressed by the
 * version id alone because that is what the turn was told the subject is.
 *
 * ## Identity and tenancy
 *
 * Service-to-service, guarded by `GRID_INTERNAL_API_TOKEN` via
 * `internalApiRoute` (fail-closed when the token is unconfigured), and READ
 * ONLY: nothing here writes a row, so the signed request-context envelope that
 * `POST /api/internal/document-versions` demands is not the door being opened.
 *
 * The organization is the boundary and the caller states it, exactly as
 * `/api/internal/document-file` does — but REQUIRED here rather than optional,
 * because a version id is not addressed through an unguessable collection name.
 * It goes into the tenant slot and into the predicate, so a version id from
 * another tenant finds no row and answers 404, indistinguishable from an id
 * that never existed.
 */

import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { readVersionForService } from '@/lib/documents/lifecycle'

type Params = { versionId: string }

const querySchema = z.object({
  organizationId: z.string().min(1),
})

export const GET = internalApiRoute<Params>(
  'document-version-content',
  async ({ request, params }) => {
    const { organizationId } = parseQuery(request, querySchema)
    return withTenant({ organizationId }, async () => {
      const version = await readVersionForService(params.versionId, organizationId)
      // JSON and not `text/plain`: the caller needs the version's STATE and its
      // content hash beside the bytes — it stamps both onto the working-directory
      // file so a later `file_draft` on that path replaces this open version
      // instead of filing a second document.
      return version
    })
  },
  {
    tenancy: { fromPayload: '?organizationId — required; a version id carries no scope of its own' },
  },
)
