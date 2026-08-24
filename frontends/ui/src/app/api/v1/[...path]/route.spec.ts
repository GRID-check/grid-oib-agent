/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Break the authkit-nextjs import chain (pulls in next/cache) at load time.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue(null),
}))

// Anonymous mode: resolveOptionalSession() returns null without touching auth/db.
vi.mock('@/lib/proxy/collection-authz', () => ({
  parseQueryContext: vi.fn(() => ({})),
  resolveRequestContext: vi.fn(() => ({})),
  validateCollectionName: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn().mockResolvedValue({ headerValue: 'scope' }),
}))

vi.mock('@/lib/proxy/proxy-request', () => ({
  buildProxyUrl: vi.fn(() => 'http://aiq-agent:8000/v1/data_sources'),
}))

import { DELETE, GET, POST } from './route'

const originalRequireAuth = process.env.REQUIRE_AUTH

describe('/api/v1/[...path] proxy — control-plane path blocking', () => {
  beforeEach(() => {
    // Anonymous mode so the proxy never resolves a WorkOS session / DB.
    delete process.env.REQUIRE_AUTH
    vi.restoreAllMocks()
  })

  afterEach(() => {
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
  })

  it.each([
    ['GET', GET, ['admin', 'oib', 'sync']],
    ['POST', POST, ['admin', 'oib', 'sync']],
    ['DELETE', DELETE, ['admin', 'oib', 'sync']],
    ['POST', POST, ['maintenance', 'purge-project-resources']],
  ])(
    '%s blocks the internal control-plane path %s with 404 and never forwards upstream',
    async (_method, handler, path) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const res = await handler(
        new Request(`https://grid.example/api/v1/${path.join('/')}`, { method: _method }),
        { params: Promise.resolve({ path }) }
      )

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } })
      // The block must happen BEFORE any upstream fetch.
      expect(fetchSpy).not.toHaveBeenCalled()
    }
  )

  it('forwards a legitimate path (data_sources) to the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const res = await GET(
      new Request('https://grid.example/api/v1/data_sources', { method: 'GET' }),
      {
        params: Promise.resolve({ path: ['data_sources'] }),
      }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [] })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('http://aiq-agent:8000/v1/data_sources')
  })
})
