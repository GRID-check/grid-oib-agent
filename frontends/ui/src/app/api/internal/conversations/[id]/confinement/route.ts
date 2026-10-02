/**
 * INTERNAL service endpoint — is this conversation still its asker's alone?
 * (ADR-0078.)
 *
 * The WebSocket upgrade puts a cleared member's restricted-folder collections
 * into the signed scope only on a conversation nobody else can read, and that
 * scope is fixed for the socket's life. Sharing the thread while the socket is
 * open would let the next turn write restricted content into a thread others
 * read and watch live. So the agent asks here before every turn whose signed
 * scope carries a restricted collection (`aiq_api.chat_socket`), and closes the
 * socket when the answer is no: the reconnect is signed a scope without them.
 *
 * The ask is also the turn's admission, and it writes: a yes records that this
 * conversation ran a turn with a restricted collection in its scope
 * (`conversation_restricted_turns`), before the turn has produced a word. The
 * sharing service refuses to widen a conversation with that mark, so an answer
 * that used a restricted summary without citing it, or a share attempted while
 * the answer streams, cannot carry restricted content to anyone else.
 *
 * `POST` with `{ organizationId, userId }` → `{ confined: boolean }`. The
 * organization travels in the body the tenancy contract reads it from; the
 * agent sends the organization and asker the BFF signed into the socket's
 * envelope, and the conversation id the socket is bound to. Token-guarded
 * (`internalApiRoute`); the lookup and the mark run in that organization, so
 * the token grants no cross-tenant reach. The mark is written only on a yes,
 * which needs the thread to be that asker's, private and ungranted (or not yet
 * created): a caller cannot mark someone else's thread to block its sharing.
 */

import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { admitRestrictedTurn } from '@/lib/conversations/confinement'

type Params = { id: string }

const confinementSchema = z.object({
  organizationId: z.string().min(1).max(128),
  // The asker, as the BFF signed it into the socket's envelope.
  userId: z.string().min(1).max(128),
})

/** The id is written into the mark, so it is bounded like every other id the agent sends. */
const CONVERSATION_ID_MAX_LENGTH = 128

export const POST = internalApiRoute<Params>(
  'Internal Conversation Confinement',
  async ({ request, params }) => {
    const { organizationId, userId } = await parseJsonBody(request, confinementSchema)
    if (params.id.length > CONVERSATION_ID_MAX_LENGTH) throw new BadRequestError('Conversation id too long')
    const confined = await withTenant({ organizationId }, () =>
      admitRestrictedTurn(organizationId, userId, params.id)
    )
    return { confined }
  },
  { tenancy: { fromPayload: 'body.organizationId' } }
)
