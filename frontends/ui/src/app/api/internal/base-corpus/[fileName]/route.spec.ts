/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeleteObjectCommand } from '@aws-sdk/client-s3'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))
vi.mock('server-only', () => ({}))

const send = vi.fn()
vi.mock('@/lib/s3', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3')
  return { ...actual, s3Client: { send: (...args: unknown[]) => send(...args) }, bucketName: 'grid-documents' }
})

import { DELETE } from './route'

const request = (token: string | null = 'test-token'): Request =>
  new Request('http://localhost/api/internal/base-corpus/x.pdf', {
    method: 'DELETE',
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

const call = (fileName: string, token: string | null = 'test-token'): Promise<Response> =>
  DELETE(request(token), { params: Promise.resolve({ fileName }) })

describe('DELETE /api/internal/base-corpus/[fileName]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
    send.mockResolvedValue({})
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await call('x.pdf', null)).status).toBe(403)
    expect((await call('x.pdf', 'wrong')).status).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await call('x.pdf')).status).toBe(503)
    expect(send).not.toHaveBeenCalled()
  })

  it('400s a name that is not a plain PDF basename', async () => {
    for (const fileName of ['..', '../x.pdf', 'a/x.pdf', 'a\\x.pdf', 'x.txt', 'x\u0000.pdf']) {
      expect((await call(fileName)).status, JSON.stringify(fileName)).toBe(400)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('deletes the base-corpus object from the platform bucket', async () => {
    const res = await call('OIB-RL 2.pdf')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect((send.mock.calls[0][0] as DeleteObjectCommand).input).toEqual({
      Bucket: 'grid-documents',
      Key: 'base-corpus/OIB-RL 2.pdf',
    })
  })

  it('is idempotent: deleting again, or a key that was never there, is still a success', async () => {
    // S3 DeleteObject answers 204 for a missing key, so the SDK resolves.
    expect((await call('gone.pdf')).status).toBe(200)
    expect((await call('gone.pdf')).status).toBe(200)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('surfaces a store failure rather than reporting a delete that did not happen', async () => {
    send.mockRejectedValue(new Error('store down'))
    expect((await call('x.pdf')).status).toBe(500)
  })
})
