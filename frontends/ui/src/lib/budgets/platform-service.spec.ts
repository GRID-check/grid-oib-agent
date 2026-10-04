/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridSession } from '@/lib/auth/types'
import { getTenantContext, withTenant } from '@/lib/db/tenant-context'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { NotFoundError, UnprocessableError } from '@/lib/api/errors'

const requirePlatformPermission = vi.fn()
const hasPlatformPermission = vi.fn()
vi.mock('@/lib/authz/platform', () => ({
  requirePlatformPermission: (...args: unknown[]) => requirePlatformPermission(...args),
  hasPlatformPermission: (...args: unknown[]) => hasPlatformPermission(...args),
}))

const getOrganization = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ organizations: { getOrganization } }),
}))

const getOrgBudget = vi.fn()
const getSpendTotals = vi.fn()
const setBudgetPolicy = vi.fn()
vi.mock('./service', () => ({
  BudgetValidationError: class extends Error {},
  getOrgBudget: (...args: unknown[]) => getOrgBudget(...args),
  getSpendTotals: (...args: unknown[]) => getSpendTotals(...args),
  setBudgetPolicy: (...args: unknown[]) => setBudgetPolicy(...args),
}))

const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}))

import { getPlatformOrgBudget, savePlatformOrgBudget } from './platform-service'

const session: GridSession = {
  userId: 'user_operator',
  email: 'operator@example.com',
  name: null,
  accessToken: '',
  organizationId: 'org_platform',
  organizationMembershipId: 'om_operator',
  role: 'org-platform-owner',
  permissions: [],
  featureFlags: null,
}
const request = new Request('http://localhost/api/platform/organizations/org_tenant/budgets', { method: 'PUT' })
const budget = { unit: 'credit', dailyLimit: 1000, monthlyLimit: 10000, explicit: false }
const input = { unit: 'credit' as const, dailyLimit: 500, monthlyLimit: 20000, note: 'Pilot allowance' }

describe('platform organization allowances', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requirePlatformPermission.mockResolvedValue(undefined)
    hasPlatformPermission.mockResolvedValue(true)
    getOrganization.mockResolvedValue({ id: 'org_tenant' })
    getOrgBudget.mockResolvedValue(budget)
    getSpendTotals.mockResolvedValue({
      day: { credits: 25, tokens: 1000 },
      month: { credits: 300, tokens: 20000 },
    })
    setBudgetPolicy.mockResolvedValue({ id: 'policy_1', currency: 'credit' })
    recordAuditEvent.mockResolvedValue(undefined)
  })

  it('reads the target allowance, not the operator active organization', async () => {
    getOrgBudget.mockImplementation(async () => {
      expect(getTenantContext()).toMatchObject({ organizationId: 'org_tenant', userId: 'user_operator' })
      return budget
    })
    await withTenant({ organizationId: 'org_platform' }, async () => {
      expect(await getPlatformOrgBudget(session, 'org_tenant')).toEqual({
        organizationId: 'org_tenant',
        ...budget,
        dayUsed: 25,
        monthUsed: 300,
        canManage: true,
      })
      expect(getTenantContext()).toMatchObject({ organizationId: 'org_platform' })
    })
    expect(getOrgBudget).toHaveBeenCalledWith('org_tenant')
    expect(getSpendTotals).toHaveBeenCalledWith('org_tenant')
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, PLATFORM_PERMISSIONS.organizationsView)
  })

  it('preserves the existing token unit instead of interpreting it as credits', async () => {
    getOrgBudget.mockResolvedValue({ ...budget, unit: 'token', dailyLimit: null, monthlyLimit: null })
    expect(await getPlatformOrgBudget(session, 'org_tenant')).toMatchObject({
      unit: 'token', dayUsed: 1000, monthUsed: 20000,
    })
  })

  it('makes read-only support visible to the editor', async () => {
    hasPlatformPermission.mockResolvedValue(false)
    expect(await getPlatformOrgBudget(session, 'org_tenant')).toMatchObject({ canManage: false })
  })

  it('denies reads and writes before probing whether an organization exists', async () => {
    requirePlatformPermission.mockRejectedValue(new Error('Forbidden'))
    await expect(getPlatformOrgBudget(session, 'org_tenant')).rejects.toThrow('Forbidden')
    await expect(savePlatformOrgBudget(session, 'org_tenant', input, request)).rejects.toThrow('Forbidden')
    expect(getOrganization).not.toHaveBeenCalled()
    expect(setBudgetPolicy).not.toHaveBeenCalled()
  })

  it('refuses an unknown organization without writing orphan policies', async () => {
    getOrganization.mockRejectedValue(Object.assign(new Error('Missing'), { status: 404 }))
    await expect(savePlatformOrgBudget(session, 'org_missing', input, request)).rejects.toBeInstanceOf(NotFoundError)
    expect(setBudgetPolicy).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('does not hide upstream directory failures as missing organizations', async () => {
    getOrganization.mockRejectedValue(new Error('WorkOS unavailable'))
    await expect(getPlatformOrgBudget(session, 'org_tenant')).rejects.toThrow('WorkOS unavailable')
  })

  it('saves through the existing policy writer and audits the target organization', async () => {
    setBudgetPolicy.mockImplementation(async () => {
      expect(getTenantContext()).toMatchObject({ organizationId: 'org_tenant' })
      return { id: 'policy_1', currency: 'credit' }
    })
    await savePlatformOrgBudget(session, 'org_tenant', input, request)
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, PLATFORM_PERMISSIONS.organizationsManage)
    expect(setBudgetPolicy).toHaveBeenCalledWith({
      organizationId: 'org_tenant',
      scope: 'organization',
      subjectId: null,
      dailyLimit: 500,
      monthlyLimit: 20000,
      expectedUnit: 'credit',
      actorUserId: 'user_operator',
      note: 'Pilot allowance',
    })
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org_tenant',
      action: 'budget.policy.set',
      targetId: 'policy_1',
      actor: { userId: 'user_operator', email: 'operator@example.com' },
      metadata: { scope: 'organization', subjectId: null, unit: 'credit', dailyLimit: 500, monthlyLimit: 20000 },
    }))
  })

  it('validates direct service callers before any policy write', async () => {
    await expect(savePlatformOrgBudget(session, 'org_tenant', { ...input, monthlyLimit: -1 }, request))
      .rejects.toBeInstanceOf(UnprocessableError)
    expect(setBudgetPolicy).not.toHaveBeenCalled()
  })

  it('does not report success or audit a failed policy write', async () => {
    setBudgetPolicy.mockRejectedValue(new Error('Database unavailable'))
    await expect(savePlatformOrgBudget(session, 'org_tenant', input, request)).rejects.toThrow('Database unavailable')
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})
