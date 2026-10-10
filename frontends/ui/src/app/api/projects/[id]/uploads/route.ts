/**
 * A project's upload history (ticket „Verlauf/Protokoll", ADR-0086): who
 * brought how many files in when, and how they ended, one keyset page at a
 * time (`?cursor=` from the previous page's `nextCursor`, `null` on the last
 * page). The per-file detail stays in each uploader's summary.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { decodeDocumentListCursor, documentListCursorParam } from '@/lib/documents/list-cursor'
import { listProjectUploadHistory } from '@/lib/upload-batches/service'

type Params = { id: string }

const querySchema = z.object({ cursor: documentListCursorParam })

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { cursor } = parseQuery(request, querySchema)
    return listProjectUploadHistory(session, params.id, {
      cursor: cursor ? (decodeDocumentListCursor(cursor) ?? undefined) : undefined,
    })
  },
  { authz: { enforcedBy: 'listProjectUploadHistory -> requireProjectAccess (project:view)' } }
)
