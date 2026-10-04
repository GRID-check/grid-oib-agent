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

const getPlatformOrgBudget = vi.fn()
const savePlatformOrgBudget = vi.fn()
vi.mock('@/lib/budgets/platform-service', () => ({
  getPlatformOrgBudget: (...args: unknown[]) => getPlatformOrgBudget(...args),
  savePlatformOrgBudget: (...args: unknown[]) => savePlatformOrgBudget(...args),
}))

import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { ConflictError } from '@/lib/api/errors'
import { GET, PUT } from './route'

const context = { params: Promise.resolve({ organizationId: 'org_tenant' }) }
const url = 'http://localhost/api/platform/organizations/org_tenant/budgets'
const valid = { unit: 'credit', dailyLimit: 1000, monthlyLimit: 25000 }
const put = (body: unknown) => PUT(new Request(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}), context)

describe('platform organization budget route', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requirePlatformPermission.mockResolvedValue(undefined)
    getPlatformOrgBudget.mockResolvedValue({ ...valid, organizationId: 'org_tenant', canManage: true })
    savePlatformOrgBudget.mockResolvedValue({ ...valid, explicit: true })
  })

  it('reads the URL organization under the organizations-view permission', async () => {
    expect((await GET(new Request(url), context)).status).toBe(200)
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, PLATFORM_PERMISSIONS.organizationsView)
    expect(getPlatformOrgBudget).toHaveBeenCalledWith(session, 'org_tenant')
  })

  it('requires organizations-manage to save the allowance', async () => {
    expect((await put(valid)).status).toBe(200)
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, PLATFORM_PERMISSIONS.organizationsManage)
    expect(savePlatformOrgBudget).toHaveBeenCalledWith(session, 'org_tenant', valid, expect.any(Request))
  })

  it('rejects unauthorized callers without reaching the service', async () => {
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
    expect((await GET(new Request(url), context)).status).toBe(403)
    expect((await put(valid)).status).toBe(403)
    expect(getPlatformOrgBudget).not.toHaveBeenCalled()
    expect(savePlatformOrgBudget).not.toHaveBeenCalled()
  })

  it.each([
    { ...valid, monthlyLimit: -1 },
    { ...valid, monthlyLimit: 100_000_000 },
    { ...valid, dailyLimit: '1000' },
    { ...valid, organizationId: 'org_other' },
    { ...valid, scope: 'member' },
    { dailyLimit: 10, monthlyLimit: 100 },
  ])('rejects invalid or widened writes before the service: %j', async (body) => {
    expect((await put(body)).status).toBe(400)
    expect(savePlatformOrgBudget).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON', async () => {
    expect((await PUT(new Request(url, { method: 'PUT', body: '{broken' }), context)).status).toBe(400)
    expect(savePlatformOrgBudget).not.toHaveBeenCalled()
  })

  it('accepts unlimited and zero allowances', async () => {
    expect((await put({ ...valid, dailyLimit: null, monthlyLimit: 0 })).status).toBe(200)
    expect((await put({ ...valid, dailyLimit: 0, monthlyLimit: null })).status).toBe(200)
  })

  it('reports a stale unit as a conflict', async () => {
    savePlatformOrgBudget.mockRejectedValue(new ConflictError('Organization budget unit changed'))
    expect((await put(valid)).status).toBe(409)
  })
})
