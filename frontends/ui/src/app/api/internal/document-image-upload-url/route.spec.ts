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
  presignDocumentImageUpload: vi.fn(),
}))

import { POST } from './route'
import { presignDocumentImageUpload } from '@/lib/documents/service'

const DOC_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'

const request = (body: unknown, token: string | null = 'test-token'): Request =>
  new Request('http://localhost/api/internal/document-image-upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-grid-internal-token': token } : {}) },
    body: JSON.stringify(body),
  })

const validBody = { documentId: DOC_ID, collection: 'proj_1', imageIndex: 3 }

describe('POST /api/internal/document-image-upload-url', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await POST(request(validBody, null))).status).toBe(403)
    expect((await POST(request(validBody, 'wrong'))).status).toBe(403)
    expect(presignDocumentImageUpload).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await POST(request(validBody))).status).toBe(503)
  })

  it('400s a body that is not a document id, a collection and a non-negative integer index', async () => {
    expect((await POST(request({ ...validBody, documentId: 'not-a-uuid' }))).status).toBe(400)
    expect((await POST(request({ ...validBody, collection: '' }))).status).toBe(400)
    expect((await POST(request({ ...validBody, imageIndex: -1 }))).status).toBe(400)
    expect((await POST(request({ ...validBody, imageIndex: 1.5 }))).status).toBe(400)
    expect((await POST(request({ ...validBody, imageIndex: '3' }))).status).toBe(400)
    expect(presignDocumentImageUpload).not.toHaveBeenCalled()
  })

  // The service returns null both for an unknown row and for an index past
  // MAX_STORED_IMAGES_PER_DOCUMENT; either way the backend keeps the caption
  // and stops asking, so one status covers both.
  it('404s when the service cannot place the image', async () => {
    vi.mocked(presignDocumentImageUpload).mockResolvedValue(null)
    expect((await POST(request(validBody))).status).toBe(404)
    expect(vi.mocked(presignDocumentImageUpload).mock.calls[0]).toEqual([DOC_ID, 'proj_1', 3, undefined])
  })

  it('returns the presigned PUT and the key it lands on', async () => {
    vi.mocked(presignDocumentImageUpload).mockResolvedValue({
      uploadUrl: 'http://seaweedfs/grid-documents/org/o1/project/p1/doc/d1/_img/3.jpg?X-Amz-Signature=abc',
      storageKey: 'org/o1/project/p1/doc/d1/_img/3.jpg',
    })
    const res = await POST(request(validBody))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      uploadUrl: 'http://seaweedfs/grid-documents/org/o1/project/p1/doc/d1/_img/3.jpg?X-Amz-Signature=abc',
      storageKey: 'org/o1/project/p1/doc/d1/_img/3.jpg',
    })
  })

  it('forwards organizationId to the service when the body carries one', async () => {
    vi.mocked(presignDocumentImageUpload).mockResolvedValue(null)
    await POST(request({ ...validBody, collection: 'archiv_org_1', organizationId: 'org_1' }))
    expect(vi.mocked(presignDocumentImageUpload).mock.calls[0]).toEqual([DOC_ID, 'archiv_org_1', 3, 'org_1'])
  })
})
