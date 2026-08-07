/**
 * Storage quota rules.
 *
 * What these protect, in order of how expensive the bug would be:
 *   - an org with no quota is UNLIMITED (introducing quotas must not
 *     retroactively block tenants who were never given a limit);
 *   - an explicit null beats the platform default, so "deliberately unlimited"
 *     survives an operator later setting a fleet-wide floor;
 *   - the ceiling is checked against total stored bytes PLUS the incoming file,
 *     not against either alone;
 *   - a quota below current usage is refused, because accepting it strands the
 *     tenant in a state no upload can fix.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const getOrgSettings = vi.fn()
const updateOrgSettings = vi.fn()
const aggregateStorageUsage = vi.fn()
const sumStorageBytes = vi.fn()
const recordAuditEvent = vi.fn()

vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: (...args: unknown[]) => getOrgSettings(...args),
  updateOrgSettings: (...args: unknown[]) => updateOrgSettings(...args),
}))

vi.mock('./repository', () => ({
  aggregateStorageUsage: (...args: unknown[]) => aggregateStorageUsage(...args),
  sumStorageBytes: (...args: unknown[]) => sumStorageBytes(...args),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}))

import type { GridSession } from '@/lib/auth/types'
import {
  assertWithinStorageQuota,
  getStorageQuotaBytes,
  setStorageQuota,
  STORAGE_QUOTA_SETTING,
} from './service'

const GB = 1e9

const platformSession = (): GridSession => ({
  userId: 'user-1',
  email: 'admin@example.com',
  name: 'Admin',
  accessToken: 'token',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'admin',
  permissions: ['org:settings:manage'],
  featureFlags: null,
  profilePictureUrl: null,
})

const settingsWith = (value: unknown): { settings: Record<string, unknown> } => ({
  settings: value === undefined ? {} : { [STORAGE_QUOTA_SETTING]: value },
})

describe('storage quota', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.GRID_DEFAULT_STORAGE_QUOTA_BYTES
    getOrgSettings.mockResolvedValue(settingsWith(undefined))
    sumStorageBytes.mockResolvedValue(0)
    updateOrgSettings.mockResolvedValue(undefined)
    aggregateStorageUsage.mockResolvedValue({
      project: { bytes: 0, documents: 0 },
      archiv: { bytes: 0, documents: 0 },
      total: { bytes: 0, documents: 0 },
    })
  })

  describe('getStorageQuotaBytes', () => {
    it('is unlimited when nothing is configured', async () => {
      await expect(getStorageQuotaBytes('org-1')).resolves.toBeNull()
    })

    it('uses the platform default when the org has not set one', async () => {
      process.env.GRID_DEFAULT_STORAGE_QUOTA_BYTES = String(50 * GB)
      await expect(getStorageQuotaBytes('org-1')).resolves.toBe(50 * GB)
    })

    it('lets an org value win over the platform default', async () => {
      process.env.GRID_DEFAULT_STORAGE_QUOTA_BYTES = String(50 * GB)
      getOrgSettings.mockResolvedValue(settingsWith(10 * GB))
      await expect(getStorageQuotaBytes('org-1')).resolves.toBe(10 * GB)
    })

    it('treats an explicit null as deliberately unlimited, not as unset', async () => {
      process.env.GRID_DEFAULT_STORAGE_QUOTA_BYTES = String(50 * GB)
      getOrgSettings.mockResolvedValue(settingsWith(null))
      await expect(getStorageQuotaBytes('org-1')).resolves.toBeNull()
    })

    it('ignores a nonsense platform default rather than blocking every upload', async () => {
      process.env.GRID_DEFAULT_STORAGE_QUOTA_BYTES = 'not-a-number'
      await expect(getStorageQuotaBytes('org-1')).resolves.toBeNull()
    })
  })

  describe('assertWithinStorageQuota', () => {
    it('allows anything when unlimited, without querying usage', async () => {
      await expect(assertWithinStorageQuota('org-1', 5 * GB)).resolves.toBeUndefined()
      expect(sumStorageBytes).not.toHaveBeenCalled()
    })

    it('allows an upload that exactly fills the quota', async () => {
      getOrgSettings.mockResolvedValue(settingsWith(10 * GB))
      sumStorageBytes.mockResolvedValue(9 * GB)
      await expect(assertWithinStorageQuota('org-1', 1 * GB)).resolves.toBeUndefined()
    })

    it('refuses the upload that would cross the quota', async () => {
      getOrgSettings.mockResolvedValue(settingsWith(10 * GB))
      sumStorageBytes.mockResolvedValue(9 * GB)
      await expect(assertWithinStorageQuota('org-1', 1 * GB + 1)).rejects.toMatchObject({
        status: 507,
        code: 'STORAGE_QUOTA_EXCEEDED',
      })
    })

    it('refuses when already over, even for a zero-byte file', async () => {
      getOrgSettings.mockResolvedValue(settingsWith(10 * GB))
      sumStorageBytes.mockResolvedValue(11 * GB)
      await expect(assertWithinStorageQuota('org-1', 0)).rejects.toMatchObject({ status: 507 })
    })
  })

  describe('setStorageQuota', () => {
    it('refuses a quota below what is already stored', async () => {
      sumStorageBytes.mockResolvedValue(8 * GB)
      await expect(setStorageQuota(platformSession(), 'org-1', 5 * GB)).rejects.toMatchObject({ status: 422 })
      expect(updateOrgSettings).not.toHaveBeenCalled()
    })

    it('refuses a non-positive quota', async () => {
      await expect(setStorageQuota(platformSession(), 'org-1', 0)).rejects.toMatchObject({ status: 422 })
    })

    it('stores a valid quota and audits it', async () => {
      sumStorageBytes.mockResolvedValue(1 * GB)
      await setStorageQuota(platformSession(), 'org-1', 10 * GB)

      expect(updateOrgSettings).toHaveBeenCalledWith('org-1', {
        settings: { [STORAGE_QUOTA_SETTING]: 10 * GB },
      })
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'org.storage_quota.updated',
          organizationId: 'org-1',
          metadata: { quotaBytes: 10 * GB },
        })
      )
    })

    it('clears the quota with null, and records it as unlimited', async () => {
      await setStorageQuota(platformSession(), 'org-1', null)

      expect(updateOrgSettings).toHaveBeenCalledWith('org-1', {
        settings: { [STORAGE_QUOTA_SETTING]: null },
      })
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { quotaBytes: 0 } })
      )
    })

    it('writes to the organization it was given, not the caller session', async () => {
      // The platform owner's own session may carry a different org (or none).
      // Reading the target off the session instead of the argument would let a
      // quota land on whichever tenant the operator happened to be browsing.
      await setStorageQuota(platformSession(), 'org-other', 10 * GB)
      expect(updateOrgSettings).toHaveBeenCalledWith('org-other', expect.anything())
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-other' })
      )
    })

    // NOTE: there is deliberately no "refuses a non-platform caller" case. The
    // gate is `platformApiRoute`'s requirePlatformOwner, which runs before the
    // handler; asserting a second check inside the service would test a belt
    // that does not exist and would drift from the route that does.
  })
})
