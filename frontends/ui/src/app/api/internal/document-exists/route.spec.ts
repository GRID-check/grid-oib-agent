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
  documentStillExists: vi.fn(),
}))

import { GET } from './route'
import { documentStillExists } from '@/lib/documents/service'

const DOC_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'

const request = (
  query = `?documentId=${DOC_ID}&collection=proj_1`,
  token: string | null = 'test-token'
): Request =>
  new Request(`http://localhost/api/internal/document-exists${query}`, {
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

describe('GET /api/internal/document-exists', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await GET(request(undefined, null))).status).toBe(403)
    expect((await GET(request(undefined, 'wrong'))).status).toBe(403)
    expect(documentStillExists).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await GET(request())).status).toBe(503)
  })

  it('400s a query that is not a document id and a collection', async () => {
    expect((await GET(request('?documentId=not-a-uuid&collection=proj_1'))).status).toBe(400)
    expect((await GET(request(`?documentId=${DOC_ID}`))).status).toBe(400)
    expect((await GET(request(`?documentId=${DOC_ID}&collection=`))).status).toBe(400)
    expect(documentStillExists).not.toHaveBeenCalled()
  })

  // The backend discards what it indexed on a definite "no" only, and a 404 is
  // also what a BFF without this route answers — so a missing row is a 200
  // that says so, never a 404.
  it('answers a missing document with 200 and exists: false', async () => {
    vi.mocked(documentStillExists).mockResolvedValue(false)
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: false })
    expect(vi.mocked(documentStillExists).mock.calls[0]).toEqual([DOC_ID, 'proj_1', undefined])
  })

  it('answers a live document with exists: true', async () => {
    vi.mocked(documentStillExists).mockResolvedValue(true)
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: true })
  })

  it('forwards organizationId when the query carries one', async () => {
    vi.mocked(documentStillExists).mockResolvedValue(true)
    await GET(request(`?documentId=${DOC_ID}&collection=archiv_org_1&organizationId=org_1`))
    expect(vi.mocked(documentStillExists).mock.calls[0]).toEqual([DOC_ID, 'archiv_org_1', 'org_1'])
  })

  it('does not answer "no" when the lookup fails', async () => {
    vi.mocked(documentStillExists).mockRejectedValue(new Error('db down'))
    expect((await GET(request())).status).toBe(500)
  })
})
