import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Break the authkit-nextjs import chain (pulls in next/cache) at load time.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue(null),
}))

// Anonymous mode: no session/db lookups for collection scoping.
vi.mock('@/lib/proxy/collection-authz', () => ({
  parseQueryContext: vi.fn(() => ({})),
  parseBodyContext: vi.fn(() => ({})),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn().mockResolvedValue({ headerValue: 'scope' }),
}))

import { GET } from './route'

const originalRequireAuth = process.env.REQUIRE_AUTH

const getRequest = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { method: 'GET', headers })

const streamParams = (path: string[]) => ({ params: Promise.resolve({ path }) })

describe('/api/jobs/async/[...path] proxy — SSE reconnection resume', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Anonymous mode so the proxy never resolves a WorkOS session / DB.
    delete process.env.REQUIRE_AUTH
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('data: {}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
  })

  it('routes a stream reconnect with a Last-Event-ID header to the /stream/{last_event_id} endpoint', async () => {
    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream', { 'Last-Event-ID': '42' }),
      streamParams(['job', 'job-1', 'stream'])
    )

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v1/jobs/async/job/job-1/stream/42')
  })

  it('streams from the beginning when no Last-Event-ID header is present', async () => {
    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream'),
      streamParams(['job', 'job-1', 'stream'])
    )

    expect(res.status).toBe(200)
    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1\/stream$/)
  })

  it('ignores a non-numeric Last-Event-ID header (backend event ids are integers)', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream', {
        'Last-Event-ID': 'abc; DROP TABLE',
      }),
      streamParams(['job', 'job-1', 'stream'])
    )

    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1\/stream$/)
  })

  it('does not append the header to an explicit /stream/{id} resume request', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream/7', { 'Last-Event-ID': '42' }),
      streamParams(['job', 'job-1', 'stream', '7'])
    )

    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1\/stream\/7$/)
  })

  it('leaves non-stream requests untouched by the Last-Event-ID header', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ job_id: 'job-1', status: 'running', error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1', { 'Last-Event-ID': '42' }),
      streamParams(['job', 'job-1'])
    )

    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1$/)
  })
})
