/**
 * `GET /api/conversations/:id/live` — watch a turn as it happens.
 *
 * Server-Sent Events carrying the agent's outbound frames for ONE conversation,
 * so a colleague sees the answer being written and the reasoning being done
 * rather than a spinner followed by a finished block of text. The asker gets the
 * same frames over their own agent WebSocket; this is the read-only version for
 * everyone else in the thread.
 *
 * **Why a second stream rather than `/api/stream`.** That one is per user and
 * carries change hints for the whole session — inbox badges, sharing changes,
 * thread activity — at a rate of a handful of events per minute. This is per
 * conversation, carries hundreds of frames per turn, exists only while a turn is
 * running, and is subscribed to only by people looking at that thread. Folding
 * token deltas into the session channel would push them at every open tab.
 *
 * **Nothing here is authoritative** (spec RT-4 is intact). Not one byte of this
 * stream is state a client has to converge on: the finished answer is persisted
 * and arrives through the ordinary `conversation.message` → refetch path whether
 * or not any of this was delivered. That is what lets the whole route degrade to
 * a single `unsupported` event when there is no shared cache tier to read from.
 *
 * **No replay, deliberately.** A subscriber sees frames from the moment it
 * attaches. Buffering the turn so far would mean deciding which of the buffered
 * frames belong to the turn that is running *now* — the bus's replay stream is
 * per conversation, not per turn — and getting that wrong shows a colleague a
 * stale answer under a live banner. Opening the thread mid-turn is the only case
 * that loses anything, and it loses only the tokens already spoken: the banner is
 * still there, and the finished answer still lands.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import {
  LIVE_REAUTHORIZE_MS,
  requireConversationSpectator,
  stillMayWatchConversation,
} from '@/lib/conversations/live'
import {
  conversationFramesAvailable,
  subscribeConversationFrames,
} from '@/lib/events/conversation-frames'

type Params = { id: string }

/** Heartbeat cadence. Comfortably under the 60s idle timeout of typical proxies. */
const HEARTBEAT_MS = 25_000
/**
 * Reconnect delay after a drop. Shorter than `/api/stream`'s five seconds: this
 * connection only exists while a turn is running, and five seconds of a
 * ninety-second turn is a visible hole in the answer.
 */
const RETRY_MS = 2_000

/** Long-lived response: never prerender, never cache. */
export const dynamic = 'force-dynamic'

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated

    // Before anything is opened. Throws `NotFoundError` for a thread this reader
    // may not see, which the factory renders as a 404.
    await requireConversationSpectator(session, params.id)

    const conversationId = params.id
    const encoder = new TextEncoder()
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let recheck: ReturnType<typeof setInterval> | null = null
    let unsubscribe: (() => Promise<void>) | null = null
    let closed = false

    /** Idempotent: whichever exit path fires first wins, the other is a no-op. */
    const teardown = async (): Promise<void> => {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      if (recheck) clearInterval(recheck)
      heartbeat = null
      recheck = null
      const release = unsubscribe
      unsubscribe = null
      if (!release) return
      try {
        await release()
      } catch (error) {
        console.warn('[live] unsubscribe failed:', error)
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        /**
         * Enqueueing on a closed stream throws, and the close can happen between
         * a frame arriving and this running. Swallow it and stop writing: the
         * observer is gone, and there is nothing to report to.
         */
        const write = (chunk: string): void => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            void teardown()
          }
        }
        const close = (): void => {
          void teardown()
          try {
            controller.close()
          } catch {
            // Already closed by the cancel path.
          }
        }

        write(`retry: ${RETRY_MS}\n\n`)

        // No cross-process frame channel (no REDIS_URL): say so once and end,
        // rather than holding a connection that can never deliver. The browser
        // reads this as "fall back to the turn banner" and does not reconnect.
        if (!conversationFramesAvailable()) {
          write(`data: ${JSON.stringify({ kind: 'unsupported' })}\n\n`)
          close()
          return
        }

        // An immediate comment so the connection is established (and any
        // buffering proxy has flushed) before the first frame.
        write(': connected\n\n')
        heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS)

        const release = await subscribeConversationFrames(conversationId, (frame) => {
          write(`data: ${JSON.stringify({ kind: 'frame', ...frame })}\n\n`)
        })
        if (!release) {
          // Configured but unreachable. Same answer as "not configured": the
          // observer keeps the banner and the finished answer still lands.
          write(`data: ${JSON.stringify({ kind: 'unsupported' })}\n\n`)
          close()
          return
        }
        // The observer can disconnect while subscribe() is still in flight;
        // without this the handle would be stored after teardown already ran.
        if (closed) {
          await release().catch(() => {})
          return
        }
        unsubscribe = release

        // Access can be revoked while this is open, and a stream that outlives the
        // grant is a subscription to a thread the reader may no longer read.
        recheck = setInterval(() => {
          void stillMayWatchConversation(session, conversationId).then((allowed) => {
            if (allowed || closed) return
            write(`data: ${JSON.stringify({ kind: 'revoked' })}\n\n`)
            close()
          })
        }, LIVE_REAUTHORIZE_MS)

        request.signal.addEventListener('abort', () => void teardown(), { once: true })
        if (request.signal.aborted) await teardown()
      },
      async cancel() {
        await teardown()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Tell nginx-class proxies not to buffer, or frames arrive in batches —
        // which for a token stream is the whole feature gone.
        'X-Accel-Buffering': 'no',
      },
    })
  },
  { authz: { enforcedBy: 'requireConversationSpectator (requireResourceAccess, viewer)' } }
)
