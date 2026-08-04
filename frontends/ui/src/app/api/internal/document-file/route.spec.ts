/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/documents/service', () => ({
  findDocumentStorageKey: vi.fn(),
}))

import { GET } from './route'
import { findDocumentStorageKey } from '@/lib/documents/service'

const request = (query = '?collection=proj_1&filename=plan.png', token: string | null = 'test-token'): Request =>
  new Request(`http://localhost/api/internal/document-file${query}`, {
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

describe('GET /api/internal/document-file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await GET(request('?collection=proj_1&filename=plan.png', null))).status).toBe(403)
    expect((await GET(request('?collection=proj_1&filename=plan.png', 'wrong'))).status).toBe(403)
    expect(findDocumentStorageKey).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await GET(request())).status).toBe(503)
  })

  it('400s when collection or filename is missing/empty', async () => {
    expect((await GET(request('?filename=plan.png'))).status).toBe(400)
    expect((await GET(request('?collection=proj_1'))).status).toBe(400)
    expect((await GET(request('?collection=&filename=plan.png'))).status).toBe(400)
    expect(findDocumentStorageKey).not.toHaveBeenCalled()
  })

  it('404s when the document index has no row for the pair', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue(null)
    const res = await GET(request())
    expect(res.status).toBe(404)
    expect(vi.mocked(findDocumentStorageKey).mock.calls[0]).toEqual(['proj_1', 'plan.png', undefined])
  })

  it('forwards organizationId to the service when the query param is present', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue({
      storageKey: 'org/o1/archiv/doc/d1/plan.png',
      contentType: 'image/png',
    })
    const res = await GET(request('?collection=archiv_org_1&filename=plan.png&organizationId=org_1'))
    expect(res.status).toBe(200)
    expect(vi.mocked(findDocumentStorageKey).mock.calls[0]).toEqual(['archiv_org_1', 'plan.png', 'org_1'])
  })

  it('passes no organizationId to the service when the query param is absent', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue(null)
    await GET(request())
    expect(vi.mocked(findDocumentStorageKey).mock.calls[0][2]).toBeUndefined()
  })

  it('returns the storage key and content type for a known document', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue({
      storageKey: 'org/o1/project/p1/doc/d1/plan.png',
      contentType: 'image/png',
    })
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      storageKey: 'org/o1/project/p1/doc/d1/plan.png',
      contentType: 'image/png',
    })
  })
})
