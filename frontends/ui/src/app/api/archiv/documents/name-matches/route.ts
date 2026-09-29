/**
 * Archiv API — which of these filenames does the Archiv already hold?
 *
 * The upload planner's name probe for the org-wide shelf; the same contract as
 * `POST /api/documents/name-matches` (`lib/documents/name-probe-types.ts`).
 * Thin handler; all logic lives in `@/lib/archiv/service`. Feature-gated by
 * the dark-launch `organization-archiv` flag (ADR-0024), same as the list.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { probeArchivDocumentNames } from '@/lib/archiv/service'
import { archivNameProbeRequestSchema } from '@/lib/documents/name-probe-types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.orgArchiv)
    if (gated) return gated
    const { names } = await parseJsonBody(request, archivNameProbeRequestSchema)
    return { documents: await probeArchivDocumentNames(session, names) }
  },
  {
    authz: {
      sessionOnly: true,
      why: "read-only probe of the caller's own org Archiv by filename; scoped by session.organizationId, the same names listArchiv already shows any member",
    },
  }
)
