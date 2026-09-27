/**
 * How the WebSocket proxy in `server.js` reports a spliced socket going away.
 *
 * `backendProxy.ws()` splices the browser socket to the aiq-agent socket. Once
 * the 101 is written, a socket error on either side is almost always one peer
 * leaving: the tab closed, a phone radio dropped, uvicorn's keepalive gave up
 * (close code 1011), a pod rolled. Node reports those as `write EPIPE` or
 * `read ECONNRESET`, and at ERROR each one filed a GitHub issue (#588, #775,
 * #784) for an outcome the chat client already recovers from by reconnecting
 * and sending `attach{turn_id, after_seq}` for every open turn.
 *
 * So after the upgrade those codes log at WARN with the side and the age of
 * the connection, and the first close logs at INFO naming the side that closed,
 * which is what tells "the browser left" from "the backend hung up". Anything
 * else stays ERROR.
 *
 * http-proxy also routes an upstream socket error through the `ws()` callback
 * (`onOutgoingError` in `passes/ws-incoming.js`), the same callback that
 * rejects a failed upgrade. Writing `HTTP/1.1 502` there after the 101 injects
 * HTTP bytes into a WebSocket stream, so `handleWsProxyError` only destroys a
 * socket that was already spliced.
 *
 * CommonJS and import-free because `server.js` requires it at startup; the
 * production image copies it in by path (`deploy/Dockerfile`).
 */

// Socket-level failures reaching the aiq-agent Service BEFORE the upgrade.
// Every one means "the backend was not there for this attempt", which during a
// rolling deploy, a node drain or a pod restart is the expected state for a few
// seconds: the client reconnects and the next upgrade lands on a ready pod.
// Logged at WARN so the err2issue exporter (ADR-0031) leaves them alone; volume
// in the dashboard is what tells a rollout from an outage. Classified on
// `err.code`, the structured field Node guarantees, never on the message.
const TRANSIENT_UPSTREAM_CODES = new Set([
  'ECONNREFUSED', // no ready endpoint behind the Service (rollout, restart)
  'ECONNRESET', // the pod went away mid-handshake
  'EPERM', // connect blocked locally (NetworkPolicy/CNI reject during churn)
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND', // pod DNS not resolvable yet (StatefulSet scale-up)
  'EAI_AGAIN', // cluster DNS temporarily unavailable (CoreDNS restart)
  'ETIMEDOUT',
  'EPIPE',
])

// A peer leaving an ALREADY-SPLICED socket.
const TEARDOWN_CODES = new Set([
  'EPIPE', // we wrote after the peer closed
  'ECONNRESET', // the peer reset (tab killed, radio lost, pod gone)
  'ECONNABORTED',
  'ERR_STREAM_DESTROYED', // a pipe wrote into the side that already closed
  'ETIMEDOUT', // TCP keepalive gave up on a silent peer
])

const isTransientUpstreamFailure = (err) => TRANSIENT_UPSTREAM_CODES.has(err?.code)
const isTeardownError = (err) => TEARDOWN_CODES.has(err?.code)

// Client sockets whose upgrade completed. A WeakSet so a socket is never kept
// alive by being in it.
const spliced = new WeakSet()

const seconds = (ms) => (ms / 1000).toFixed(1)

/**
 * Watch a spliced pair: classify errors, log the first close, close the other.
 *
 * Call it from the upstream request's 'upgrade' event, which fires before
 * http-proxy writes the 101 and pipes the two sockets together.
 *
 * @param {import('net').Socket} client the browser's socket
 * @param {import('net').Socket} upstream the aiq-agent socket
 * @param {{ logger?: Pick<Console, 'info' | 'warn' | 'error'>, now?: () => number }} [options]
 */
function watchSplicedSockets(client, upstream, { logger = console, now = Date.now } = {}) {
  spliced.add(client)
  const openedAt = now()
  const age = () => seconds(now() - openedAt)
  // The side that failed or closed FIRST. An error counts: http-proxy destroys
  // the client synchronously on an upstream error, so the client's 'close'
  // would otherwise arrive first and take the blame.
  let firstSide = null
  let closeLogged = false

  const onError = (side) => (err) => {
    firstSide ??= side
    if (isTeardownError(err)) {
      logger.warn('[WebSocket] %s socket %s after %ss (peer left)', side, err.code, age())
    } else {
      logger.error('[WebSocket] %s socket error after %ss:', side, age(), err?.message)
    }
  }
  const onClose = (side, other) => (hadError) => {
    firstSide ??= side
    if (!closeLogged) {
      closeLogged = true
      logger.info('[WebSocket] closed by %s after %ss', firstSide, age())
    }
    // The pipe ends the other side on a clean 'end' but not on an error, so a
    // reset on one side would leave the other open and idle until keepalive.
    if (hadError) other.destroy()
    else other.end()
  }

  client.on('error', onError('client'))
  upstream.on('error', onError('upstream'))
  client.once('close', onClose('client', upstream))
  upstream.once('close', onClose('upstream', client))
}

/**
 * The `backendProxy.ws()` error callback.
 *
 * Before the upgrade: log (WARN for a missing backend, ERROR otherwise), answer
 * 502 and destroy. After it: the socket carries WebSocket frames, and
 * `watchSplicedSockets` has already logged the error, so only destroy.
 *
 * @param {Error & { code?: string }} err
 * @param {import('net').Socket} socket the browser's socket
 * @param {{ logger?: Pick<Console, 'warn' | 'error'> }} [options]
 */
function handleWsProxyError(err, socket, { logger = console } = {}) {
  if (spliced.has(socket)) {
    socket.destroy()
    return
  }
  if (isTransientUpstreamFailure(err)) {
    logger.warn('[WS Proxy] Backend unreachable (%s), rejecting upgrade', err.code)
  } else {
    logger.error('[WS Proxy] Error:', err?.message)
  }
  try {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  } catch {}
  socket.destroy()
}

module.exports = {
  TEARDOWN_CODES,
  TRANSIENT_UPSTREAM_CODES,
  handleWsProxyError,
  isTeardownError,
  isTransientUpstreamFailure,
  watchSplicedSockets,
}
