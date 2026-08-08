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
const updatePlatformOwnedOrgSettings = vi.fn()
const aggregateStorageUsage = vi.fn()
const sumStorageBytes = vi.fn()
const recordAuditEvent = vi.fn()
const findOrganization = vi.fn()

vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: (...args: unknown[]) => getOrgSettings(...args),
  updatePlatformOwnedOrgSettings: (...args: unknown[]) => updatePlatformOwnedOrgSettings(...args),
}))

vi.mock('@/lib/organizations/repository', () => ({
  findOrganization: (...args: unknown[]) => findOrganization(...args),
}))

vi.mock('./repository', () => ({
  aggregateStorageUsage: (...args: unknown[]) => aggregateStorageUsage(...args),
  sumStorageBytes: (...args: unknown[]) => sumStorageBytes(...args),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}))

// Mocked at the predicate, not at WorkOS: what this file is about is whether
// `setStorageQuota` CONSULTS it, and in what order relative to everything else it
// does. `isPlatformOwner` itself is covered in `authz/platform.spec.ts`.
const isPlatformOwner = vi.fn()
vi.mock('@/lib/authz/platform', async () => {
  const actual = await import('@/lib/authz/platform')
  return {
    ...actual,
    isPlatformOwner: (...args: unknown[]) => isPlatformOwner(...args),
    requirePlatformOwner: async (session: unknown) => {
      if (!(await isPlatformOwner(session))) throw new actual.PlatformAccessDeniedError()
    },
  }
})

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

/** Point the usage aggregate at a total, for the guard that reads it. */
const usedBytes = (bytes: number, documents = 1): void => {
  aggregateStorageUsage.mockResolvedValue({
    project: { bytes, documents },
    archiv: { bytes: 0, documents: 0 },
    total: { bytes, documents },
  })
}

describe('storage quota', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.GRID_DEFAULT_STORAGE_QUOTA_BYTES
    getOrgSettings.mockResolvedValue(settingsWith(undefined))
    sumStorageBytes.mockResolvedValue(0)
    updatePlatformOwnedOrgSettings.mockResolvedValue(undefined)
    aggregateStorageUsage.mockResolvedValue({
      project: { bytes: 0, documents: 0 },
      archiv: { bytes: 0, documents: 0 },
      total: { bytes: 0, documents: 0 },
    })
    // Known to Grid by default; the "unknown organization" tests opt out.
    findOrganization.mockResolvedValue({ workosOrganizationId: 'org-1', settings: {} })
    // The platform owner by default; the authorization tests opt out.
    isPlatformOwner.mockResolvedValue(true)
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
      usedBytes(8 * GB)
      await expect(setStorageQuota(platformSession(), 'org-1', 5 * GB)).rejects.toMatchObject({ status: 422 })
      expect(updatePlatformOwnedOrgSettings).not.toHaveBeenCalled()
    })

    // The organization is looked up once and the reading reused, rather than
    // summed for the guard and aggregated again for the response: two reads mean
    // the number validated against and the number returned can disagree.
    it('reads the organization\'s usage exactly once', async () => {
      usedBytes(1 * GB)
      await setStorageQuota(platformSession(), 'org-1', 10 * GB)
      expect(aggregateStorageUsage).toHaveBeenCalledTimes(1)
      expect(sumStorageBytes).not.toHaveBeenCalled()
    })

    // `updateOrgSettings` upserts, so without an existence check a mistyped id
    // in the URL creates a settings row and an audit event for a tenant that
    // does not exist.
    it('refuses an organization Grid has never heard of', async () => {
      findOrganization.mockResolvedValue(null)
      await expect(setStorageQuota(platformSession(), 'org-typo', 10 * GB)).rejects.toMatchObject({
        status: 404,
      })
      expect(updatePlatformOwnedOrgSettings).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    // "Known" is the set the platform console lists: a settings row OR at least
    // one document. Requiring the row alone would reject exactly the tenants an
    // operator most wants to bound — a busy org that never opened its settings.
    it('accepts an organization with documents but no settings row', async () => {
      findOrganization.mockResolvedValue(null)
      usedBytes(3 * GB, 12)
      await setStorageQuota(platformSession(), 'org-busy', 10 * GB)
      expect(updatePlatformOwnedOrgSettings).toHaveBeenCalledWith(
        platformSession(),
        'org-busy',
        expect.anything()
      )
    })

    it('refuses a non-positive quota', async () => {
      await expect(setStorageQuota(platformSession(), 'org-1', 0)).rejects.toMatchObject({ status: 422 })
    })

    it('stores a valid quota and audits it', async () => {
      usedBytes(1 * GB)
      await setStorageQuota(platformSession(), 'org-1', 10 * GB)

      expect(updatePlatformOwnedOrgSettings).toHaveBeenCalledWith(platformSession(), 'org-1', {
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

      expect(updatePlatformOwnedOrgSettings).toHaveBeenCalledWith(platformSession(), 'org-1', {
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
      expect(updatePlatformOwnedOrgSettings).toHaveBeenCalledWith(
        platformSession(),
        'org-other',
        expect.anything()
      )
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-other' })
      )
    })

    /**
     * The authorization is the service's, not the route's.
     *
     * This file used to carry a note explaining why there was deliberately no
     * such test: the gate was `platformApiRoute`'s `requirePlatformOwner`, and
     * asserting a second check here "would test a belt that does not exist". The
     * note was accurate and the design was wrong. This function probes whether an
     * organization exists, writes a platform-owned setting, and records who
     * changed it — so a caller reaching it any other way got an enumeration
     * oracle over every organization id and a row in the audit log. A guard in
     * another file is a fact about today's call graph, and call graphs change
     * without anyone revisiting the comment that depended on them.
     */
    it('refuses a caller who is not the platform owner', async () => {
      isPlatformOwner.mockResolvedValue(false)
      await expect(setStorageQuota(platformSession(), 'org-1', 10 * GB)).rejects.toMatchObject({
        status: 403,
      })
      expect(updatePlatformOwnedOrgSettings).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    it('refuses before it can be used to probe which organizations exist', async () => {
      // Ordering, not just presence: checking authorization AFTER the existence
      // lookup would answer "does org-X exist?" with 404-vs-403 for anyone who
      // could reach the function.
      isPlatformOwner.mockResolvedValue(false)
      await expect(setStorageQuota(platformSession(), 'org-typo', 10 * GB)).rejects.toMatchObject({
        status: 403,
      })
      expect(findOrganization).not.toHaveBeenCalled()
      expect(aggregateStorageUsage).not.toHaveBeenCalled()
    })
  })
})
