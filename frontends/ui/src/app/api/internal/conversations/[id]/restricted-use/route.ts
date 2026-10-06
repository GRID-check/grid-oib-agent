/**
 * INTERNAL service endpoint — which restricted folders a chat turn may draw on,
 * and the admission that records it did (ADR-0080).
 *
 * A conversation is restricted by what it USES: a restricted collection is used
 * when content from it enters the model's context. The agent asks here twice:
 *
 *   * at turn start, with `candidates` (the restricted collections its signed
 *     scope carries): which of them the asker and everyone the conversation is
 *     shared with may READ now (`drawable`), and which source folders the
 *     conversation already recorded that still restrict someone (`recorded`,
 *     folder ids, opaque to the agent: non-empty means the conversation is
 *     confined). The turn searches only the drawable ones, so a share made
 *     between turns narrows the next turn's search;
 *   * before restricted content enters the model's context, with `admit`: each
 *     collection's source folder is checked against the conversation's
 *     audience again and recorded, atomically with every widening of that
 *     audience (`admitRestrictedUse`). A refused collection's content is
 *     dropped from the turn.
 *
 * `POST` with `{ organizationId, userId, projectId?, candidates?, admit? }` →
 * `{ drawable, admitted, refused, recorded }`. Token-guarded
 * (`internalApiRoute`); everything runs in the organization the body states,
 * and the organization, asker and project are what the BFF signed into the
 * turn's envelope. A record only ever narrows who may read the conversation,
 * and the audience check reads the conversation's own row, so the token grants
 * no way to widen anything.
 */

import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import {
  ADMISSION_MAX_COLLECTIONS,
  admitRestrictedUse,
  drawableRestrictedCollections,
  recordedRestrictedFolders,
} from '@/lib/conversations/restricted-use'

type Params = { id: string }

const collectionList = z.array(z.string().min(1).max(200)).max(ADMISSION_MAX_COLLECTIONS).default([])

const restrictedUseSchema = z.object({
  organizationId: z.string().min(1).max(128),
  // The asker, as the BFF signed it into the turn's envelope.
  userId: z.string().min(1).max(128),
  // The turn's project; read only for a conversation whose row does not exist yet.
  projectId: z.string().min(1).max(128).nullish(),
  candidates: collectionList,
  admit: collectionList,
})

/** The id is written into the record, so it is bounded like every other id the agent sends. */
const CONVERSATION_ID_MAX_LENGTH = 128

export const POST = internalApiRoute<Params>(
  'Internal Conversation Restricted Use',
  async ({ request, params }) => {
    const body = await parseJsonBody(request, restrictedUseSchema)
    if (params.id.length > CONVERSATION_ID_MAX_LENGTH) throw new BadRequestError('Conversation id too long')
    const useRequest = {
      organizationId: body.organizationId,
      conversationId: params.id,
      userId: body.userId,
      projectId: body.projectId ?? null,
    }
    return withTenant({ organizationId: body.organizationId }, async () => {
      const drawable = await drawableRestrictedCollections(useRequest, body.candidates)
      if (body.admit.length === 0) {
        return {
          drawable,
          admitted: [],
          refused: [],
          recorded: await recordedRestrictedFolders(params.id, body.organizationId),
        }
      }
      return { drawable, ...(await admitRestrictedUse(useRequest, body.admit)) }
    })
  },
  { tenancy: { fromPayload: 'body.organizationId' } }
)
