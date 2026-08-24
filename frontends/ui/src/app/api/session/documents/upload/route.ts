/**
 * Session document upload API — store a file attached privately to one chat and
 * hand it to the document pipeline (ADR-0047 Phase 2).
 *
 * This replaces posting the file straight at the Python ingestor through
 * `/api/v1/collections/s_<id>/documents`, which created chunks and nothing
 * else. Thin handler; all logic — including the authorization, which resolves
 * on the CONVERSATION rather than on a project — lives in
 * `@/lib/session-documents/service`.
 */

import { apiRoute, parseFormData } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { uploadSessionDocument } from '@/lib/session-documents/service'
import { parseConversationId } from '../conversation-id'

export const POST = apiRoute(
  async ({ session, request }) => {
    const formData = await parseFormData(request)
    const projectId = formData.get('projectId')
    const file = formData.get('file')

    // The id decides which conversation is created or resolved, which rows the
    // document is filed against, and which retrieval collection the bytes are
    // ingested into — so its shape is checked here, at the edge, before any of
    // that. Deliberately NOT `uuid()`: see `../conversation-id`.
    const conversationId = parseConversationId(formData.get('conversationId'))

    if (!(file instanceof File)) {
      throw new BadRequestError('file is required')
    }

    return uploadSessionDocument(
      session,
      {
        conversationId,
        // Only used when the conversation row has to be created here; it is
        // never written onto the document, whose project is NULL by design.
        projectId: typeof projectId === 'string' && projectId ? projectId : null,
        file,
      },
      request,
    )
  },
  {
    authz: {
      enforcedBy:
        'uploadSessionDocument (createConversation → requireResourceAccess conversation:collaborator, and project:view when a project is named)',
    },
  },
)
