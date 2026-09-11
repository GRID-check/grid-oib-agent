/**
 * Conversation draft-preview API — read one unfiled draft into the browser.
 *
 * Thin handler; all logic lives in `@/lib/conversations/draft-preview`. The
 * card already names the draft (path, version, bytes); this is the door that
 * fetches its CONTENT so the reader can look at it before asking Piloti to
 * file it. Read-only end to end: the service calls the agent tier's `asearch`
 * / `aget` doors and never touches `grid_app`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { readConversationDraft } from '@/lib/conversations/draft-preview'

type Params = { id: string }

const draftPreviewQuerySchema = z.object({
  // The working-directory path as the card carries it (`/entwuerfe/….md`).
  // Length-capped like every other client-supplied identifier; legitimacy is
  // decided by the service and the backend's own path refusal, not here.
  path: z.string().min(1).max(500),
})

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { path } = parseQuery(request, draftPreviewQuerySchema)
    return readConversationDraft(session, params.id, path)
  },
  { authz: { enforcedBy: 'readConversationDraft (requireResourceAccess)' } },
)
