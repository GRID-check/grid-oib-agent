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
 * The organization is the boundary and the caller STATES it, exactly as
 * `/api/internal/document-file` does. That is not enough on its own here, and
 * the difference is the address: a collection name is unguessable, a version id
 * is a uuid the caller supplies. Anything holding the internal token could
 * therefore name any tenant and read any version's bytes.
 *
 * So the route also requires the CONVERSATION the turn is running in, and
 * refuses unless that conversation's subject IS this version's document
 * (`conversations.subject_resource_type = 'document'`). The subject was written
 * by a person's own session through the file-native ask, so the pair is exactly
 * the authority the turn already had. A version from another tenant, a version
 * this conversation is not about, and an id that never existed all answer the
 * same 404 — „exists, but not for you" is the sentence that makes an id worth
 * guessing.
 */

import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { readVersionForService } from '@/lib/documents/version-content'

type Params = { versionId: string }

const querySchema = z.object({
  organizationId: z.string().min(1),
  /**
   * The conversation whose subject this version must be. Required, and named
   * exactly `conversationId` because the Python caller spells it that way.
   */
  conversationId: z.string().min(1),
})

export const GET = internalApiRoute<Params>(
  'document-version-content',
  async ({ request, params }) => {
    const { organizationId, conversationId } = parseQuery(request, querySchema)
    return withTenant({ organizationId }, async () => {
      const version = await readVersionForService(params.versionId, organizationId, conversationId)
      // JSON and not `text/plain`: the caller needs the version's STATE and its
      // content hash beside the bytes — it stamps both onto the working-directory
      // file so a later `file_draft` on that path replaces this open version
      // instead of filing a second document.
      return version
    })
  },
  {
    tenancy: {
      fromPayload:
        '?organizationId — required; a version id carries no scope of its own. ?conversationId ' +
        'narrows it further: the version must be that conversation’s subject resource.',
    },
  },
)
