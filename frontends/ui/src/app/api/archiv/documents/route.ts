/**
 * Archiv API — list the organization's Archiv documents, one keyset page at a
 * time (`?cursor=` from the previous page's `nextCursor`).
 * Thin handler; all logic lives in `@/lib/archiv/service`. Feature-gated by the
 * dark-launch `organization-archiv` flag (ADR-0024).
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { listArchiv } from '@/lib/archiv/service'
import { decodeDocumentListCursor, documentListCursorParam } from '@/lib/documents/list-cursor'

const listArchivQuerySchema = z.object({ cursor: documentListCursorParam })

export const GET = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.orgArchiv)
    if (gated) return gated
    const { cursor } = parseQuery(request, listArchivQuerySchema)
    return listArchiv(session, { cursor: cursor ? (decodeDocumentListCursor(cursor) ?? undefined) : undefined })
  },
  {
    authz: {
      sessionOnly: true,
      why: 'the Archiv is org-wide shared knowledge; listArchiv scopes to session.organizationId and reports canManage for the UI',
    },
  }
)
