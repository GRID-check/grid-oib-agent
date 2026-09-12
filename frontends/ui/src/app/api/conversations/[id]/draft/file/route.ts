/**
 * Conversation draft-filing API — file one unfiled draft into the project.
 *
 * Thin handler; all logic lives in `@/lib/conversations/draft-filing`. The
 * card already names the draft (path, title); this is the door that files its
 * CONTENT as the signed-in user, through the same `fileAgentDocumentDraft` the
 * agent's internal route reaches. The browser and the agent converge on one
 * document through the shared idempotency reference, never on two.
 *
 * A same-name collision is a 409 carrying the existing row
 * (`details.documentId`, `details.displayName`): the card answers it with an
 * explicit „Trotzdem ablegen" confirmation (`force`) rather than versioning
 * onto an unrelated document.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { fileConversationDraft } from '@/lib/conversations/draft-filing'

type Params = { id: string }

const fileDraftBodySchema = z
  .object({
    // The working-directory path as the card carries it (`/entwuerfe/….md`).
    // Length-capped like the preview door; legitimacy is decided by the
    // service and the backend's own path refusal, not here.
    path: z.string().min(1).max(500),
    // The card's title. Optional so an older client still files — the service
    // falls back to the path's file name.
    title: z.string().max(500).optional(),
    // Set after the card showed the same-name 409 and the reader confirmed.
    force: z.boolean().optional().default(false),
  })
  .strict()

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, fileDraftBodySchema)
    return fileConversationDraft(
      session,
      params.id,
      { path: body.path, title: body.title, force: body.force },
      request,
    )
  },
  {
    authz: {
      enforcedBy:
        'fileConversationDraft (requireResourceAccess on the conversation, fileAgentDocumentDraft gates on the project)',
    },
    status: 201,
  },
)
