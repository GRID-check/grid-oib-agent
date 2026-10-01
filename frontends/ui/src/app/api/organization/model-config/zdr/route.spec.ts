/**
 * @vitest-environment node
 */
/**
 * The zero-data-retention toggle, down to the service it calls: the gate is
 * this route (the generic settings save refuses the key), so the permission,
 * the feature flag, the audit with before/after values and BOTH cache deletes
 * have to hold here. Only storage, the caches and the audit sink are stubbed;
 * `setOrgZdrOnly` runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org_1',
  email: 'admin@grid.com',
  role: 'admin',
  permissions: [] as string[],
  featureFlags: ['runtime-model-config'] as string[] | null,
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

const stored: { settings: Record<string, unknown> } = { settings: {} }
const upsertOrganization = vi.fn(async (row: { settings: Record<string, unknown> }) => {
  stored.settings = row.settings
})
vi.mock('@/lib/organizations/repository', () => ({
  findOrganization: vi.fn(async () => ({
    workosOrganizationId: 'org_1',
    displayName: null,
    defaultLocale: 'de',
    settings: stored.settings,
  })),
  upsertOrganization: (row: { settings: Record<string, unknown> }) => upsertOrganization(row),
}))

const invalidateCached = vi.fn()
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: (key: string) => invalidateCached(key),
}))
const invalidateBackendModelConfig = vi.fn()
vi.mock('@/lib/model-config/backend-key', () => ({
  invalidateBackendModelConfig: (organizationId: string) => invalidateBackendModelConfig(organizationId),
}))
const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (event: unknown) => recordAuditEvent(event) }))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn(), WEB_SEARCH_FLAG: 'web-search' }))

const isZdrApplicableForOrg = vi.fn(async (_organizationId: string) => true)
vi.mock('@/lib/model-config/org-catalog', () => ({
  isZdrApplicableForOrg: (organizationId: string) => isZdrApplicableForOrg(organizationId),
}))
const BLOCKED = {
  status: 'checked',
  blockedGroups: [{ group: 'deep_research', modelId: 'vendor/no-zdr', source: 'platform', reason: 'not_zdr' }],
  unresolvedGroups: [],
}
const getZdrCoverage = vi.fn(async (_organizationId: string) => BLOCKED)
vi.mock('@/lib/model-config/zdr-coverage', () => ({
  UNKNOWN_COVERAGE: { status: 'unknown', blockedGroups: [], unresolvedGroups: [] },
  getZdrCoverage: (organizationId: string) => getZdrCoverage(organizationId),
}))

import { PUT } from './route'

const put = (body: unknown): Promise<Response> =>
  PUT(
    new Request('http://localhost/api/organization/model-config/zdr', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

describe('PUT /api/organization/model-config/zdr', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.role = 'admin'
    session.featureFlags = ['runtime-model-config']
    stored.settings = {}
    isZdrApplicableForOrg.mockResolvedValue(true)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses a caller without org:models:manage', async () => {
    session.role = 'member'
    expect((await put({ enabled: false })).status).toBe(403)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('refuses when the model-configuration flag is off for the org', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    session.featureFlags = []
    expect((await put({ enabled: false })).status).toBe(403)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean', async () => {
    expect((await put({ enabled: 'no' })).status).toBe(400)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('turns ZDR off, audits before and after, and drops both caches', async () => {
    const res = await put({ enabled: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ zdrOnly: false, zdrApplicable: true, zdrCoverage: null })
    expect(stored.settings.zdrOnly).toBe(false)
    // The org had never chosen, so it WAS on: absent means ZDR.
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'model_config.zdr.updated',
        metadata: { zdrOnly: 'false', previous: 'true' },
      })
    )
    expect(invalidateCached).toHaveBeenCalledWith('zdronly:v2:org_1')
    expect(invalidateBackendModelConfig).toHaveBeenCalledWith('org_1')
    expect(getZdrCoverage).not.toHaveBeenCalled()
  })

  it('turns ZDR on without refusing, and returns the groups it blocks', async () => {
    stored.settings = { zdrOnly: false }
    const res = await put({ enabled: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ zdrOnly: true, zdrApplicable: true, zdrCoverage: BLOCKED })
    expect(stored.settings.zdrOnly).toBe(true)
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { zdrOnly: 'true', previous: 'false' } })
    )
  })

  it('never fails the response after the switch moved: post-save reads that throw read as unknown', async () => {
    isZdrApplicableForOrg.mockRejectedValueOnce(new Error('db down'))
    getZdrCoverage.mockRejectedValueOnce(new Error('db down'))
    const res = await put({ enabled: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      zdrOnly: true,
      zdrApplicable: null,
      zdrCoverage: { status: 'unknown', blockedGroups: [], unresolvedGroups: [] },
    })
    expect(stored.settings.zdrOnly).toBe(true)
  })

  it('stores the choice but computes no coverage when ZDR cannot apply (BYOK on another provider)', async () => {
    isZdrApplicableForOrg.mockResolvedValue(false)
    const res = await put({ enabled: true })
    // Coverage may be computed alongside, but is not reported for traffic Piloti cannot pin.
    expect(await res.json()).toEqual({ zdrOnly: true, zdrApplicable: false, zdrCoverage: null })
    expect(stored.settings.zdrOnly).toBe(true)
  })
})
