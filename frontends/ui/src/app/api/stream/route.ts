/**
 * `GET /api/stream` — the browser's live-update channel (spec RT-3, RT-4, RT-6, RT-7).
 *
 * Server-Sent Events, owned by the application tier. The existing chat WebSocket
 * exists to talk to the AGENT about ONE conversation; inbox badges, thread
 * activity and sharing changes are application concerns for the whole session, so
 * they get their own connection rather than being smuggled through the agent
 * socket (RT-6). SSE and not a second WebSocket because the traffic is one-way
 * server→client, reconnects are free, and it survives ordinary HTTP infra.
 *
 * **Authorization is at publish time, not here.** A subscriber is attached to
 * `user:<their own id>:events` and to nothing else, so the only thing this
 * connection can ever carry is what the server already decided to address to
 * this user (ADR-0035 §9, RT-5). There is no channel parameter to tamper with.
 *
 * **No resume, deliberately.** There is no `Last-Event-ID` handling and no replay
 * buffer: Postgres is the system of record and every client re-fetches on connect
 * and on focus, so a gap costs latency, never correctness (RT-1, RT-4). Adding a
 * replay buffer here would create a second, weaker source of truth — the exact
 * mistake ADR-0035 rejects.
 *
 * **Teardown is the load-bearing part.** Each subscription may hold its own Redis
 * subscriber client, so a connection that goes away without unsubscribing leaks a
 * client for the lifetime of the process. Both exit paths (`request.signal`
 * aborting and the stream being cancelled) run the same idempotent teardown.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { subscribeUser } from '@/lib/events/bus'

/** Heartbeat cadence. Comfortably under the 60s idle timeout of typical proxies. */
const HEARTBEAT_MS = 25_000
/** Reconnect delay the browser's EventSource should use after a drop. */
const RETRY_MS = 5_000

/** Long-lived response: never prerender, never cache. */
export const dynamic = 'force-dynamic'

export const GET = apiRoute(
  async ({ session, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated

    const encoder = new TextEncoder()
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let unsubscribe: (() => Promise<void>) | null = null
    let closed = false

    /** Idempotent: whichever exit path fires first wins, the other is a no-op. */
    const teardown = async (): Promise<void> => {
      if (closed) return
      closed = true
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      const release = unsubscribe
      unsubscribe = null
      if (!release) return
      try {
        await release()
      } catch (error) {
        console.warn('[stream] unsubscribe failed:', error)
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        /**
         * Enqueueing on a controller whose stream has closed throws, and the close
         * can happen between an event arriving and this running. Swallow it and
         * stop writing: the client is gone, there is nothing to report to.
         */
        const write = (chunk: string): void => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            void teardown()
          }
        }

        // Reconnect policy plus an immediate comment, so the connection is
        // established (and any buffering proxy has flushed) before the first event
        // rather than at the first heartbeat 25 seconds later.
        write(`retry: ${RETRY_MS}\n\n`)
        write(': connected\n\n')
        heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS)

        const release = await subscribeUser(session.userId, (envelope) => {
          write(`data: ${JSON.stringify(envelope)}\n\n`)
        })
        // The client can disconnect while subscribe() is still in flight; without
        // this the handle would be stored after teardown already ran and leak.
        if (closed) {
          await release().catch(() => {})
          return
        }
        unsubscribe = release

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
        // Tell nginx-class proxies not to buffer, or events arrive in batches.
        'X-Accel-Buffering': 'no',
      },
    })
  },
  { authz: { enforcedBy: 'per-user SSE channel keyed to session.userId' } }
)
