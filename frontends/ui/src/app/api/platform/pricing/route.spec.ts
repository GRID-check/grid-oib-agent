/**
 * @vitest-environment node
 */
/**
 * The platform pricing endpoint (ADR-0053). Pinned here: only a platform owner
 * may read or write it, a slipped decimal is refused with per-field errors
 * before anything is written, and a successful save invalidates the seeded
 * allowance cache and lands in the platform audit trail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnprocessableError } from '@/lib/api/errors'

const session = {
  userId: 'owner-1',
  organizationId: 'org_platform',
  email: 'owner@grid.com',
  role: 'org-platform-owner',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/session', () => ({ getGridSession: async () => session }))
vi.mock('@/lib/auth/require-auth', () => ({ authzErrorResponse: vi.fn().mockReturnValue(null) }))

const requirePlatformPermission = vi.fn().mockResolvedValue(undefined)
const getPlatformOrganizationId = vi.fn().mockResolvedValue('org_platform')
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/authz/platform')>()
  return {
    ...original,
    requirePlatformPermission: (s: unknown) => requirePlatformPermission(s),
    getPlatformOrganizationId: () => getPlatformOrganizationId(),
  }
})

const recordAuditEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (e: unknown) => recordAuditEvent(e) }))

const invalidateSeededLimits = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/budgets/service', () => ({ invalidateSeededLimits: () => invalidateSeededLimits() }))

const VIEW = {
  versionId: null,
  marginMultiplier: 1,
  usdPerCredit: 0.01,
  defaultOrgDailyCredits: 1000,
  defaultOrgMonthlyCredits: 10000,
  explicit: false,
  note: null,
  updatedByEmail: null,
  updatedAt: null,
  history: [],
}
const getPricingView = vi.fn().mockResolvedValue(VIEW)
const savePricing = vi.fn()
vi.mock('@/lib/pricing/service', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/pricing/service')>()
  return {
    ...original,
    getPricingView: () => getPricingView(),
    savePricing: (input: unknown) => savePricing(input),
  }
})

import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { GET, PUT } from './route'

const put = (body: unknown): Promise<Response> =>
  PUT(
    new Request('http://localhost/api/platform/pricing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

const VALID = { marginMultiplier: 2.5, usdPerCredit: 0.1, defaultOrgDailyCredits: 500, defaultOrgMonthlyCredits: 5000 }

describe('/api/platform/pricing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePlatformPermission.mockResolvedValue(undefined)
    getPlatformOrganizationId.mockResolvedValue('org_platform')
    savePricing.mockResolvedValue({ id: 'ver_2', supersedesId: 'ver_1' })
  })

  it('refuses non-owners on both methods', async () => {
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
    expect((await GET(new Request('http://localhost/api/platform/pricing'))).status).toBe(403)
    expect((await put(VALID)).status).toBe(403)
    expect(savePricing).not.toHaveBeenCalled()
  })

  it('returns the effective pricing with the bounds the form needs', async () => {
    const res = await GET(new Request('http://localhost/api/platform/pricing'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pricing.explicit).toBe(false)
    expect(body.bounds.marginMultiplier.min).toBeGreaterThan(0)
    expect(body.referenceRequest.promptTokens).toBeGreaterThan(0)
  })

  it('surfaces validation errors as 422 without writing', async () => {
    savePricing.mockRejectedValue(new UnprocessableError('Invalid pricing', { errors: ['marginMultiplier: 0.1–50'] }))
    const res = await put({ ...VALID, marginMultiplier: 500 })
    expect(res.status).toBe(422)
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(invalidateSeededLimits).not.toHaveBeenCalled()
  })

  it('rejects a malformed body before the service sees it', async () => {
    expect((await put({ marginMultiplier: 'two' })).status).toBe(400)
    expect(savePricing).not.toHaveBeenCalled()
  })

  it('saves, drops the seeded-allowance cache and audits into the platform org', async () => {
    const res = await put({ ...VALID, note: 'pilot pricing' })
    expect(res.status).toBe(200)
    expect(savePricing).toHaveBeenCalledWith(
      expect.objectContaining({ ...VALID, note: 'pilot pricing', actorUserId: 'owner-1', actorEmail: 'owner@grid.com' })
    )
    expect(invalidateSeededLimits).toHaveBeenCalledTimes(1)
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_platform',
        action: 'platform.pricing.updated',
        targetId: 'ver_2',
        metadata: expect.objectContaining({ marginMultiplier: 2.5, usdPerCredit: 0.1, supersedesId: 'ver_1' }),
      })
    )
  })

  it('keeps the save when the platform org does not resolve, and says so', async () => {
    getPlatformOrganizationId.mockResolvedValue(null)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect((await put(VALID)).status).toBe(200)
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
