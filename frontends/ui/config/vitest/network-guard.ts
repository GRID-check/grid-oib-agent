/**
 * No spec reaches the network. MSW answers what a spec mocks and lets the rest
 * through (`onUnhandledRequest: 'bypass'`), and what it lets through lands in
 * happy-dom's own fetch: an unmocked `/api/...` call from a rendered component,
 * an `<img>` or `<link>` the DOM loads. Each opened a real socket to
 * `localhost:3000`, where nothing listens, and teardown aborted it mid-flight.
 * That abort trips the libuv assertion `uv__stream_destroy` and kills the whole
 * worker fork, so a shard fails with no failing test named (the iframe case in
 * `vitest.config.ts` was the first instance of this, not the last).
 *
 * happy-dom asks this interceptor before it opens a socket, so answering here
 * means no socket ever exists. A 503 keeps the "server unreachable" meaning
 * the ECONNREFUSED had, as a response the code under test already handles.
 */
export const NETWORK_REFUSED_HEADER = 'x-vitest-network'

export function refuseNetwork(): void {
  const happyDOM = (globalThis as { happyDOM?: { settings: { fetch: { interceptor: unknown } } } }).happyDOM
  if (!happyDOM) return // a `@vitest-environment node` spec: no DOM, no happy-dom fetch
  const refused = { status: 503, statusText: 'Network disabled in tests', headers: { [NETWORK_REFUSED_HEADER]: 'refused' } }
  type RefusingWindow = { Response: typeof Response; Headers: typeof Headers }
  happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ window }: { window: RefusingWindow }) => new window.Response(null, refused),
    beforeSyncRequest: ({ request, window }: { request: Request; window: RefusingWindow }) => ({
      ...refused,
      ok: false,
      redirected: false,
      url: request.url,
      headers: new window.Headers(refused.headers),
      body: null,
    }),
  }
}
