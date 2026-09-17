/**
 * One id per request, so "es hat nicht funktioniert" and a log line can be the
 * same event.
 *
 * Before this, a failed turn gave the reader a sentence and the operator
 * nothing: `grep -c OTEL_ deploy/compose/docker-compose.coolify.yaml` is `0`,
 * and the BFF minted no correlation id of its own, so an error a user reported
 * on Tuesday could not be found in Tuesday's logs. The reader is the only person
 * who knows WHICH request failed, and the only way they can tell anyone is if
 * the failure carries something quotable.
 *
 * ## What this is and is not
 *
 * It is a correlation id: minted (or adopted) per request, echoed on the error
 * response as `x-request-id` and inside the error JSON as `requestId`, and
 * printed on the server's own log line for an unhandled error. That is enough
 * for the handshake it exists for — a user reads eight characters aloud, an
 * operator greps them.
 *
 * It is NOT a trace id, and deliberately does not pretend to be one. When OTEL
 * is wired into the deployment, the honest move is to adopt the active span's
 * trace id here instead of minting, so the id the user quotes IS the trace the
 * operator opens. That wiring is a deployment change and is not in this module.
 *
 * ## Where the pieces live
 *
 * The header name and the short form are in `@/shared/utils/request-id`,
 * because the chat client needs both and this module is server-only: it mints
 * with `node:crypto`, which must not follow a display helper into a browser
 * bundle.
 *
 * ## Why an inbound id wins
 *
 * A proxy, a load balancer or the client may already have stamped one. Adopting
 * it keeps one id across every hop instead of giving each tier its own, which is
 * the whole point of a correlation id. It is validated first: an id goes into a
 * response header and a log line, so an unbounded attacker-controlled string
 * would be a header-injection and log-forging surface. Anything that is not a
 * plain, bounded token is ignored and we mint our own.
 */

import { randomUUID } from 'node:crypto'
import { REQUEST_ID_HEADER } from '@/shared/utils/request-id'

export { REQUEST_ID_HEADER, shortRequestId } from '@/shared/utils/request-id'

/** Also accepted inbound: what several proxies stamp instead. */
const INBOUND_HEADERS = [REQUEST_ID_HEADER, 'x-correlation-id'] as const

/**
 * A safe id: printable, bounded, no separators a header or a log line would
 * read as structure.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/

/**
 * The id belongs to the request, not to the call — `errorResponse` and a log
 * line must quote the same one. Keyed weakly so nothing is retained past the
 * request object's own life.
 */
const minted = new WeakMap<Request, string>()

function inboundRequestId(request: Request): string | null {
  for (const header of INBOUND_HEADERS) {
    const value = request.headers.get(header)
    if (value && SAFE_ID.test(value)) return value
  }
  return null
}

/** The id for this request: the caller's, if it sent a usable one, else ours. */
export function resolveRequestId(request: Request): string {
  const existing = minted.get(request)
  if (existing) return existing
  const id = inboundRequestId(request) ?? randomUUID()
  minted.set(request, id)
  return id
}
