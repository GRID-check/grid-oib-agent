/**
 * `GET /api/conversations/:id/frames?after=<frame id>` — what a client missed.
 *
 * Every frame the agent sends over the asker's WebSocket is also appended to the
 * conversation's replay stream on Dragonfly (`conv:<id>:stream`,
 * `ConversationBus.publish_frame`), and reaches the socket tagged with its entry
 * id (`grid_frame_id`). A phone that drops its socket mid-answer (iOS does, the
 * moment the app goes to the background) comes back, asks for every frame after
 * the last id it applied, and feeds them through the same handler as live
 * frames. The answer it would otherwise have lost is delivered.
 *
 * Without `after`, it returns every frame the stream still holds: the reload
 * case, where the page lost its place along with its memory.
 *
 * `{ frames: null }` means there is nothing to resume from (no shared cache, or
 * the read failed). The client then asks for the finished answer instead, as it
 * did before this route existed.
 */

import { NextResponse } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { requireConversationSpectator } from '@/lib/conversations/live'
import { FRAME_ID_PATTERN } from '@/lib/conversations/frame-id'
import { readConversationFramesAfter } from '@/lib/events/conversation-frames'

type Params = { id: string }

export const dynamic = 'force-dynamic'

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    // Before any read. Throws `NotFoundError` for a thread this reader may not
    // see: the frames are the thread's answers, and the bar is reading it.
    await requireConversationSpectator(session, params.id)

    const after = new URL(request.url).searchParams.get('after')
    if (after !== null && !FRAME_ID_PATTERN.test(after)) {
      return NextResponse.json({ error: 'after must be a frame id' }, { status: 400 })
    }
    const frames = await readConversationFramesAfter(params.id, after)
    return NextResponse.json(
      { frames: frames?.map((frame) => frame.payload) ?? null },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  },
  { authz: { enforcedBy: 'requireConversationSpectator (requireResourceAccess, viewer)' } }
)
