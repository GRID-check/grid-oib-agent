/**
 * @vitest-environment node
 */
/**
 * The conversation draft-preview door: what it proxies, and what it refuses.
 *
 * The working directory lives in the agent service's own store, so this route
 * is a scoped proxy — the conversation's `viewer` gate first, the internal
 * service token second. Three properties pin that scope:
 *
 *   - it answers what the backend holds, with the internal token and the
 *     conversation id + path encoded as their own segments;
 *   - a reader who may not see the conversation gets the same 404 as an
 *     absent one (spec SH-6), and the backend is never addressed;
 *   - a missing path is a 400 that never reaches the backend either.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '@/lib/api/errors'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    role: 'member',
    permissions: [],
  }),
}))

const requireResourceAccessMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/sharing/access', () => ({
  requireResourceAccess: requireResourceAccessMock,
}))

vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))

import { GET } from './route'

const fetchMock = vi.fn()

const get = (query: string) =>
  GET(new Request(`https://grid.example/api/conversations/conv-1/draft${query}`), {
    params: Promise.resolve({ id: 'conv-1' }),
  })

describe('GET /api/conversations/[id]/draft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    vi.stubGlobal('fetch', fetchMock)
    requireResourceAccessMock.mockResolvedValue({ role: 'viewer' })
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ path: '/entwuerfe/a.md', content: '# A\n', version: 2 }),
    })
  })

  it('proxies one conversation’s draft with the internal service token', async () => {
    const res = await get('?path=%2Fentwuerfe%2Fa.md')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      path: '/entwuerfe/a.md',
      content: '# A\n',
      version: 2,
      bytes: 4,
    })
    // The gate first: only drafts of conversations the reader may access.
    expect(requireResourceAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1', organizationId: 'org_1' }),
      'conversation',
      'conv-1',
      'viewer',
    )
    const [url, init] = fetchMock.mock.calls[0]
    // One namespace element, one suffix path — each encoded as its own
    // segment, so neither can widen the read beyond this draft.
    expect(url).toBe('http://backend:8000/v1/drafts/conv-1/entwuerfe/a.md')
    expect(init.method).toBe('GET')
    expect(init.headers['x-grid-internal-token']).toBe('test-token')
  })

  it('answers 404 without addressing the backend when the reader may not see the conversation', async () => {
    requireResourceAccessMock.mockRejectedValue(new NotFoundError())

    const res = await get('?path=%2Fentwuerfe%2Fa.md')

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a backend 404 to 404', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })

    const res = await get('?path=%2Fentwuerfe%2Fa.md')

    expect(res.status).toBe(404)
  })

  it('rejects a missing path with 400 before the resource gate or any backend call', async () => {
    const res = await get('')

    expect(res.status).toBe(400)
    expect(requireResourceAccessMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
