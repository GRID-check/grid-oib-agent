/**
 * Documents API — which of these filenames does the project already hold?
 *
 * The upload planner's name probe (`lib/documents/name-probe-client.ts` is its
 * client, `name-probe-types.ts` its contract). POST because a folder drop
 * carries up to two thousand names, which no query string holds.
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { probeProjectDocumentNames } from '@/lib/documents/service'
import { projectNameProbeRequestSchema, type NameProbeResponse } from '@/lib/documents/name-probe-types'

export const POST = apiRoute(
  async ({ session, request }): Promise<NameProbeResponse> => {
    const { projectId, names } = await parseJsonBody(request, projectNameProbeRequestSchema)
    return { documents: await probeProjectDocumentNames(session, projectId, names) }
  },
  { authz: { enforcedBy: 'probeProjectDocumentNames (requireProjectAccess project:view)' } }
)
