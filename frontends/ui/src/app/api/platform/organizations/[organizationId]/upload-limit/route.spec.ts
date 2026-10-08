/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = { userId: 'user_operator', organizationId: 'org_platform' }
vi.mock('@/lib/auth/session', () => ({ getGridSession: async () => session }))

const requirePlatformPermission = vi.fn()
vi.mock('@/lib/authz/platform', () => {
  class PlatformAccessDeniedError extends Error { readonly status = 403 }
  return {
    PlatformAccessDeniedError,
    requirePlatformPermission: (...args: unknown[]) => requirePlatformPermission(...args),
  }
})

const setMaxUploadFileBytes = vi.fn()
vi.mock('@/lib/storage/upload-limit', () => ({
  setMaxUploadFileBytes: (...args: unknown[]) => setMaxUploadFileBytes(...args),
}))

import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { UnprocessableError } from '@/lib/api/errors'
import { PUT } from './route'

const context = { params: Promise.resolve({ organizationId: 'org_tenant' }) }
const url = 'http://localhost/api/platform/organizations/org_tenant/upload-limit'
const put = (body: unknown) => PUT(new Request(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}), context)

describe('platform organization upload-limit route', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requirePlatformPermission.mockResolvedValue(undefined)
    setMaxUploadFileBytes.mockResolvedValue({
      maxUploadFileBytes: 200e6,
      effectiveMaxUploadFileBytes: 200e6,
    })
  })

  it('requires organizations-manage and hands the URL organization to the service', async () => {
    const response = await put({ maxUploadFileBytes: 200e6 })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      maxUploadFileBytes: 200e6,
      effectiveMaxUploadFileBytes: 200e6,
    })
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, PLATFORM_PERMISSIONS.organizationsManage)
    expect(setMaxUploadFileBytes).toHaveBeenCalledWith(session, 'org_tenant', 200e6, expect.any(Request))
  })

  it('clears with null', async () => {
    expect((await put({ maxUploadFileBytes: null })).status).toBe(200)
    expect(setMaxUploadFileBytes).toHaveBeenCalledWith(session, 'org_tenant', null, expect.any(Request))
  })

  it('rejects unauthorized callers without reaching the service', async () => {
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
    expect((await put({ maxUploadFileBytes: 200e6 })).status).toBe(403)
    expect(setMaxUploadFileBytes).not.toHaveBeenCalled()
  })

  it.each([
    { maxUploadFileBytes: 999_999 },
    { maxUploadFileBytes: 0 },
    { maxUploadFileBytes: -1 },
    { maxUploadFileBytes: 1.5 },
    { maxUploadFileBytes: '200000000' },
    {},
  ])('rejects a value below 1 MB or not a whole number of bytes before the service: %j', async (body) => {
    expect((await put(body)).status).toBe(400)
    expect(setMaxUploadFileBytes).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON', async () => {
    expect((await PUT(new Request(url, { method: 'PUT', body: '{broken' }), context)).status).toBe(400)
    expect(setMaxUploadFileBytes).not.toHaveBeenCalled()
  })

  it('reports a value above the transport ceiling as the service refuses it', async () => {
    setMaxUploadFileBytes.mockRejectedValue(
      new UnprocessableError('Upload limit must be between 1 MB and 250 MB, the largest request this deployment accepts')
    )
    const response = await put({ maxUploadFileBytes: 900e6 })
    expect(response.status).toBe(422)
  })
})
