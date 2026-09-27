/**
 * The `/api/v1/*` requests the BFF proxy forwards to the agent service.
 *
 * **An allowlist, by method and shape.** The proxy used to forward every
 * `/v1/*` path except `admin` and `maintenance`, with the member's bearer and
 * the collection scope and nothing else. That made the agent service's whole
 * surface reachable from a browser cookie — NAT's `/v1/chat/completions` and
 * `/v1/workflow` among it, which ran full agent turns outside the signed
 * context envelope: no organization, no budget, no disabled sources, no model
 * policy. A member refused at the WebSocket upgrade could chat through here.
 * The agent service now refuses those without an envelope too
 * (`aiq_api/context_envelope.py`, deny by default); this is the other layer,
 * and it is the one that also closes whatever the agent service mounts next.
 *
 * Each entry is a request a product client actually makes, found by reading
 * the clients rather than the backend's route table:
 *
 *   - `adapters/api/data-sources-client.ts` — GET `data_sources`;
 *   - `adapters/api/documents-client.ts` — the chat attachment shelf: create a
 *     collection, read it, list / upload / delete its files, poll an ingest
 *     job (`documents/<jobId>/status`), discard an abandoned chat's collection;
 *   - `adapters/api/research-runs-client.ts` — GET `jobs/async/jobs`.
 *
 * Everything else answers 404 before any upstream request, including paths
 * the backend serves: a product need is a new line here, stated on purpose.
 * Which collection a collection request may touch is the next gate
 * (`./collection-authz`).
 */

type Segment = string | ((segment: string) => boolean)

interface ProxyRoute {
  method: 'GET' | 'POST' | 'DELETE'
  shape: readonly Segment[]
}

const ANY: Segment = (segment) => segment.length > 0

const PROXY_ROUTES: readonly ProxyRoute[] = [
  { method: 'GET', shape: ['data_sources'] },
  { method: 'GET', shape: ['documents', ANY, 'status'] },
  { method: 'GET', shape: ['jobs', 'async', 'jobs'] },
  { method: 'POST', shape: ['collections'] },
  { method: 'GET', shape: ['collections', ANY] },
  { method: 'DELETE', shape: ['collections', ANY] },
  { method: 'GET', shape: ['collections', ANY, 'documents'] },
  { method: 'POST', shape: ['collections', ANY, 'documents'] },
  { method: 'DELETE', shape: ['collections', ANY, 'documents'] },
]

function matches(route: ProxyRoute, method: string, path: readonly string[]): boolean {
  if (route.method !== method || route.shape.length !== path.length) return false
  return route.shape.every((segment, index) =>
    typeof segment === 'string' ? segment === path[index] : segment(path[index])
  )
}

/** Whether the proxy may forward this request at all. */
export function isForwardableV1Request(method: string, path: readonly string[]): boolean {
  const upper = method.toUpperCase()
  return PROXY_ROUTES.some((route) => matches(route, upper, path))
}
