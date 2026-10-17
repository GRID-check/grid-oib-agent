/**
 * `POST /api/realtime/send` — say something in a live channel (ADR-0110):
 * `{ ch, msg }`, 204. The channel's definition authorizes the sender, spends
 * its own rate limit and decides what `msg` may be; the server stamps who said
 * it (`lib/realtime/send.ts`).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { sendToChannel } from '@/lib/realtime/send'
import { sendBodySchema } from '@/lib/realtime/types'

export const POST = apiRoute(
  async ({ session, request }) => sendToChannel(session, await parseJsonBody(request, sendBodySchema)),
  {
    authz: { enforcedBy: 'registry channel.authorizeSend (sendToChannel, cached for the channel reauthorizeMs)' },
    limits: { none: true, why: 'sendToChannel spends the channel’s own limits after authorizing (the document room: ROOM_LIMIT for motion, ROOM_CLAIM_LIMIT for claims).' },
  }
)
