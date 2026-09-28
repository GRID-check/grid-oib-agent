/**
 * The headers a client may NOT hand the backend through the WebSocket proxy.
 *
 * `server.js` forwards the upgrade request's headers to the Python backend and
 * then SETS the `x-grid-*` context headers from `/api/auth/websocket-scope`. It
 * set each one only when the scope response had the field, and deleted none,
 * so a header the client sent itself went through whenever the scope had no
 * value to overwrite it with. The backend reads them as decisions the BFF made:
 * `x-grid-model-overrides` (which model every agent group runs on, at the
 * organization's expense), `x-grid-budget` (how much is left), and
 * `x-grid-disabled-sources` (the sources the organization switched off). A
 * cookie-authenticated client outside a browser could pick all three.
 *
 * So the proxy removes every inbound `x-grid-*` header before it writes its
 * own, and `authorization` too: the backend's identity is the session the BFF
 * resolved for the scope, and a caller-chosen bearer beside that cookie would
 * make the two disagree. `x-internal-token` goes with them for the same reason
 * `x-grid-internal-token` does: no browser-facing request carries the service
 * secret. The Python readers prefer the signed envelope as well
 * (`get_signed_request_context`), so neither layer trusts the other to hold.
 *
 * CommonJS and import-free because `server.js` requires it at startup; the
 * production image copies it in by path (`deploy/Dockerfile`).
 */

const CLIENT_CONTEXT_HEADER_PREFIX = 'x-grid-'
const CLIENT_CREDENTIAL_HEADERS = new Set(['authorization', 'x-internal-token'])

/**
 * Delete, in place, every inbound header only the proxy may set.
 *
 * `headers` is Node's `req.headers`, whose names are already lower-case.
 * Returns the names it removed, for a log line or a test.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {string[]}
 */
function stripClientContextHeaders(headers) {
  const removed = []
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    if (lower.startsWith(CLIENT_CONTEXT_HEADER_PREFIX) || CLIENT_CREDENTIAL_HEADERS.has(lower)) {
      delete headers[name]
      removed.push(lower)
    }
  }
  return removed
}

module.exports = { stripClientContextHeaders, CLIENT_CONTEXT_HEADER_PREFIX }
