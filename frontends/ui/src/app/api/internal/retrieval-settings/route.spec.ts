import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/retrieval-settings/service', () => ({
  getPlatformRetrievalSettings: vi.fn().mockResolvedValue({
    'knowledge.top_k': 12,
    'web.max_results': 7,
  }),
}))

import { GET } from './route'
import { getPlatformRetrievalSettings } from '@/lib/retrieval-settings/service'

const request = (token: string | null = 'test-token'): Request =>
  new Request('http://localhost/api/internal/retrieval-settings', {
    method: 'GET',
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

describe('GET /api/internal/retrieval-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await GET(request(null))).status).toBe(403)
    expect((await GET(request('wrong'))).status).toBe(403)
    expect(getPlatformRetrievalSettings).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await GET(request('anything'))).status).toBe(503)
  })

  it('returns the pinned settings map the backend resolver expects', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      settings: { 'knowledge.top_k': 12, 'web.max_results': 7 },
    })
  })

  it('returns an empty map when nothing is pinned (backend falls back to defaults)', async () => {
    vi.mocked(getPlatformRetrievalSettings).mockResolvedValueOnce({})
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ settings: {} })
  })
})
