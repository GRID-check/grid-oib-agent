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
  findDocumentImageStorageKey: vi.fn(),
}))

import { GET } from './route'
import { findDocumentImageStorageKey, findDocumentStorageKey } from '@/lib/documents/service'

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
      storageBucket: null,
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

  it('returns the storage key, its bucket and the content type for a known document', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue({
      storageKey: 'org/o1/project/p1/doc/d1/plan.png',
      storageBucket: null,
      contentType: 'image/png',
    })
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      storageKey: 'org/o1/project/p1/doc/d1/plan.png',
      storageBucket: null,
      contentType: 'image/png',
    })
  })

  // The agent tier calls get_object directly, so the bucket has to travel with
  // the key. A response that dropped it would send every per-organization
  // lookup to the shared bucket, where the object is not — a silent 404 that
  // degrades to a text-only answer with nothing in any log to explain it.
  it('passes a per-organization bucket through to the caller', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue({
      storageKey: 'org/o1/project/p1/doc/d1/plan.png',
      storageBucket: 'grid-org-o1-abcdef123456',
      contentType: 'image/png',
    })
    const res = await GET(request())
    expect(await res.json()).toMatchObject({ storageBucket: 'grid-org-o1-abcdef123456' })
  })

  // The derived-key read. The backend only ever varies a bounded integer; the
  // key itself is built from the document's row, so it cannot leave the prefix.
  describe('with imageIndex', () => {
    it('resolves the stored raster through the image lookup, not the file lookup', async () => {
      vi.mocked(findDocumentImageStorageKey).mockResolvedValue({
        storageKey: 'org/o1/project/p1/doc/d1/_img/2.jpg',
        storageBucket: null,
        contentType: 'image/jpeg',
      })
      const res = await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=2'))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        storageKey: 'org/o1/project/p1/doc/d1/_img/2.jpg',
        storageBucket: null,
        contentType: 'image/jpeg',
      })
      expect(vi.mocked(findDocumentImageStorageKey).mock.calls[0]).toEqual(['proj_1', 'plan.pdf', 2, undefined])
      expect(findDocumentStorageKey).not.toHaveBeenCalled()
    })

    it('404s when the document or the index is unknown', async () => {
      vi.mocked(findDocumentImageStorageKey).mockResolvedValue(null)
      expect((await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=99'))).status).toBe(404)
    })

    it('400s a negative or non-integer index before any lookup', async () => {
      expect((await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=-1'))).status).toBe(400)
      expect((await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=1.5'))).status).toBe(400)
      expect((await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=abc'))).status).toBe(400)
      expect(findDocumentImageStorageKey).not.toHaveBeenCalled()
    })
  })
})
