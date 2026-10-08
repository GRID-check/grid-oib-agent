/**
 * `GET /api/conversations/:id/frames?peek=1` — is a turn still producing frames?
 *
 * Every event the agent sends over the asker's socket is also appended to the
 * conversation's replay stream on Dragonfly (`conv:<id>:stream`,
 * `ConversationBus.publish_frame`). This answers `{ available, newest, now }`:
 * the newest entry's id (`<ms>-<n>`) and the server's clock, so a client whose
 * socket is gone can tell a turn still working (a heartbeat every 20 s) from
 * one that has ended, without reading a single frame. `available: false` means
 * there is no stream to ask (no shared cache, or the read failed).
 *
 * Resume is not served here. A client that lost its socket sends
 * `attach{turn_id, after_seq}` on the new one, and the agent tier replays that
 * turn itself (chat wire v2 §d). Any other query is refused with 400, so a
 * stale caller fails loudly instead of receiving frames nothing can fold.
 */

import { NextResponse } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { requireConversationSpectator } from '@/lib/conversations/live'
import { peekNewestConversationFrame } from '@/lib/events/conversation-frames'

type Params = { id: string }

export const dynamic = 'force-dynamic'

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    // Before any read. Throws `NotFoundError` for a thread this reader may not
    // see: whether it is answering is a fact about the thread.
    await requireConversationSpectator(session, params.id)

    if (new URL(request.url).searchParams.get('peek') !== '1') {
      return NextResponse.json(
        { error: 'only ?peek=1 is served; resume a turn with attach on the socket' },
        { status: 400 }
      )
    }
    const newest = await peekNewestConversationFrame(params.id)
    return NextResponse.json(
      { available: newest !== undefined, newest: newest ?? null, now: Date.now() },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  },
  { authz: { enforcedBy: 'requireConversationSpectator (requireResourceAccess, viewer)' } }
)
