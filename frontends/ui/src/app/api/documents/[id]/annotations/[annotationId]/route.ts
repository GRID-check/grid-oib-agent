/**
 * One Anmerkung of a document: GET reads it as the caller sees it (what a
 * room hint names, read again on its own), PATCH changes it (take a proposal over or
 * dismiss it, resolve or reopen it, reword it, assign it, give it a date),
 * DELETE removes one the caller set. Thin handlers; the rules live in
 * `@/lib/annotations/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { roomPeerOf } from '@/lib/annotations/peer-header'
import { deleteAnnotation, readAnnotation, updateAnnotation } from '@/lib/annotations/service'
import { updateAnnotationRequestSchema } from '@/lib/annotations/types'

type Params = { id: string; annotationId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({ annotation: await readAnnotation(session, params.id, params.annotationId) }),
  { authz: { enforcedBy: 'readAnnotation -> getAccessibleDocument (read)' } }
)

export const PATCH = apiRoute<Params>(
  async ({ session, request, params }) =>
    updateAnnotation(
      session,
      params.id,
      params.annotationId,
      await parseJsonBody(request, updateAnnotationRequestSchema),
      { kind: 'person', peerId: roomPeerOf(request) }
    ),
  { authz: { enforcedBy: 'updateAnnotation -> getAccessibleDocument (project:documents:write)' } }
)

export const DELETE = apiRoute<Params>(
  async ({ session, request, params }) =>
    deleteAnnotation(session, params.id, params.annotationId, { kind: 'person', peerId: roomPeerOf(request) }),
  { authz: { enforcedBy: 'deleteAnnotation -> getAccessibleDocument (project:documents:write), own marks only' } }
)
