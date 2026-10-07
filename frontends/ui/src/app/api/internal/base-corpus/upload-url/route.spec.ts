/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PutObjectCommand } from '@aws-sdk/client-s3'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))
vi.mock('server-only', () => ({}))

const signingClient = vi.hoisted(() => ({ name: 'signing' }))
vi.mock('@/lib/s3', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3')
  return { ...actual, signingS3Client: signingClient, s3Client: { send: vi.fn() }, bucketName: 'grid-documents' }
})
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }))

import { POST } from './route'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const request = (body: unknown, token: string | null = 'test-token'): Request =>
  new Request('http://localhost/api/internal/base-corpus/upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-grid-internal-token': token } : {}) },
    body: JSON.stringify(body),
  })

describe('POST /api/internal/base-corpus/upload-url', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
    vi.mocked(getSignedUrl).mockResolvedValue('http://seaweedfs/grid-documents/base-corpus/x.pdf?X-Amz-Signature=abc')
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await POST(request({ fileName: 'x.pdf' }, null))).status).toBe(403)
    expect((await POST(request({ fileName: 'x.pdf' }, 'wrong'))).status).toBe(403)
    expect(getSignedUrl).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await POST(request({ fileName: 'x.pdf' }))).status).toBe(503)
    expect(getSignedUrl).not.toHaveBeenCalled()
  })

  it('400s a body without a string fileName', async () => {
    expect((await POST(request({}))).status).toBe(400)
    expect((await POST(request({ fileName: 7 }))).status).toBe(400)
    expect(getSignedUrl).not.toHaveBeenCalled()
  })

  it('400s a name that is not a plain PDF basename', async () => {
    for (const fileName of ['', '..', '../x.pdf', 'a/x.pdf', 'a\\x.pdf', 'x.txt', 'x\u0000.pdf']) {
      expect((await POST(request({ fileName }))).status, JSON.stringify(fileName)).toBe(400)
    }
    expect(getSignedUrl).not.toHaveBeenCalled()
  })

  it('presigns a PUT for the platform bucket at the base-corpus key and returns both', async () => {
    const res = await POST(request({ fileName: 'OIB-RL 2.pdf' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      uploadUrl: 'http://seaweedfs/grid-documents/base-corpus/x.pdf?X-Amz-Signature=abc',
      storageKey: 'base-corpus/OIB-RL 2.pdf',
    })
    const [client, command, options] = vi.mocked(getSignedUrl).mock.calls[0]
    expect(client).toBe(signingClient)
    expect((command as PutObjectCommand).input).toEqual({
      Bucket: 'grid-documents',
      Key: 'base-corpus/OIB-RL 2.pdf',
      ContentType: 'application/pdf',
    })
    expect(options).toEqual({ expiresIn: 3600 })
  })
})
