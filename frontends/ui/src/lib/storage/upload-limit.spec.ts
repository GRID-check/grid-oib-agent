/**
 * @vitest-environment node
 */
/**
 * The per-organization upload limit.
 *
 * What these protect, in order of how expensive the bug would be:
 *   - an organization with no value of its own gets the deployment default,
 *     exactly what every tenant had before the setting existed;
 *   - no stored value can make the limit exceed the transport ceiling, because
 *     bytes past it never reach the app and the refusal would name a size that
 *     cannot arrive;
 *   - a write is visible to the next upload, not thirty seconds later;
 *   - only platform staff write it, checked before the organization is probed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const getOrgSettings = vi.fn()
const updatePlatformOwnedOrgSettings = vi.fn()
vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: (...args: unknown[]) => getOrgSettings(...args),
  updatePlatformOwnedOrgSettings: (...args: unknown[]) => updatePlatformOwnedOrgSettings(...args),
}))

const findOrganization = vi.fn()
vi.mock('@/lib/organizations/repository', () => ({
  findOrganization: (...args: unknown[]) => findOrganization(...args),
}))

const aggregateStorageUsage = vi.fn()
vi.mock('./repository', () => ({
  aggregateStorageUsage: (...args: unknown[]) => aggregateStorageUsage(...args),
}))

const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}))

const requirePlatformPermission = vi.fn()
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/authz/platform')>()
  return { ...original, requirePlatformPermission: (s: unknown) => requirePlatformPermission(s) }
})

import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { setCacheStore, type CacheStore } from '@/lib/cache'
import type { GridSession } from '@/lib/auth/types'
import {
  MAX_UPLOAD_FILE_SETTING,
  assertFileSizeAllowed,
  effectiveUploadLimit,
  getEffectiveMaxUploadBytes,
  setMaxUploadFileBytes,
  uploadLimitBounds,
} from './upload-limit'

const MB = 1e6

/** A real store, so the read-through and the invalidation are what is tested. */
const mapStore = (): CacheStore => {
  const entries = new Map<string, string>()
  return {
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => void entries.set(key, value),
    delete: async (key) => void entries.delete(key),
    deletePrefix: async (prefix) => {
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key)
    },
  }
}

const platformSession = (): GridSession => ({
  userId: 'user-1',
  email: 'staff@example.com',
  name: 'Staff',
  accessToken: 'token',
  organizationId: 'org-platform',
  organizationMembershipId: 'om-1',
  role: 'admin',
  permissions: [],
  featureFlags: null,
  profilePictureUrl: null,
})

const withOwnLimit = (value: unknown): { settings: Record<string, unknown> } => ({
  settings: value === undefined ? {} : { [MAX_UPLOAD_FILE_SETTING]: value },
})

describe('per-organization upload limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCacheStore(mapStore())
    delete process.env.FILE_UPLOAD_MAX_SIZE_MB
    delete process.env.BIM_MAX_IFC_BYTES
    getOrgSettings.mockResolvedValue(withOwnLimit(undefined))
    aggregateStorageUsage.mockResolvedValue({
      project: { bytes: 0, documents: 0 },
      archiv: { bytes: 0, documents: 0 },
      total: { bytes: 0, documents: 0 },
    })
    findOrganization.mockResolvedValue({ workosOrganizationId: 'org-1', settings: {} })
    requirePlatformPermission.mockResolvedValue(undefined)
    updatePlatformOwnedOrgSettings.mockResolvedValue(undefined)
  })

  afterEach(() => {
    delete process.env.FILE_UPLOAD_MAX_SIZE_MB
    delete process.env.BIM_MAX_IFC_BYTES
  })

  describe('bounds', () => {
    it('defaults to FILE_UPLOAD_MAX_SIZE_MB and tops out at the transport ceiling', () => {
      expect(uploadLimitBounds({})).toEqual({
        defaultBytes: 100 * MB,
        minBytes: 1 * MB,
        ceilingBytes: 250 * MB,
      })
      expect(uploadLimitBounds({ FILE_UPLOAD_MAX_SIZE_MB: '40', BIM_MAX_IFC_BYTES: String(500 * MB) }))
        .toEqual({ defaultBytes: 40 * MB, minBytes: 1 * MB, ceilingBytes: 500 * MB })
    })

    it('holds a stored value to the bounds instead of trusting it', () => {
      const bounds = uploadLimitBounds({})
      expect(effectiveUploadLimit(null, bounds)).toBe(100 * MB)
      expect(effectiveUploadLimit(20 * MB, bounds)).toBe(20 * MB)
      // Set when the ceiling was higher, read after it was lowered.
      expect(effectiveUploadLimit(900 * MB, bounds)).toBe(250 * MB)
      expect(effectiveUploadLimit(10, bounds)).toBe(1 * MB)
    })
  })

  describe('getEffectiveMaxUploadBytes', () => {
    it('is the deployment default when the organization has no value of its own', async () => {
      expect(await getEffectiveMaxUploadBytes('org-1')).toBe(100 * MB)
    })

    it('follows FILE_UPLOAD_MAX_SIZE_MB for the default', async () => {
      process.env.FILE_UPLOAD_MAX_SIZE_MB = '40'
      expect(await getEffectiveMaxUploadBytes('org-1')).toBe(40 * MB)
    })

    it("uses the organization's own value, raised or lowered", async () => {
      getOrgSettings.mockResolvedValue(withOwnLimit(200 * MB))
      expect(await getEffectiveMaxUploadBytes('org-1')).toBe(200 * MB)
      getOrgSettings.mockResolvedValue(withOwnLimit(5 * MB))
      expect(await getEffectiveMaxUploadBytes('org-2')).toBe(5 * MB)
    })

    it('never exceeds the transport ceiling, whatever is stored', async () => {
      getOrgSettings.mockResolvedValue(withOwnLimit(2_000 * MB))
      expect(await getEffectiveMaxUploadBytes('org-1')).toBe(250 * MB)
    })

    it('reads an explicit null or a malformed value as the default', async () => {
      getOrgSettings.mockResolvedValue(withOwnLimit(null))
      expect(await getEffectiveMaxUploadBytes('org-1')).toBe(100 * MB)
      getOrgSettings.mockResolvedValue(withOwnLimit('200000000'))
      expect(await getEffectiveMaxUploadBytes('org-2')).toBe(100 * MB)
    })

    it('caches per organization, and a write is visible to the next read', async () => {
      getOrgSettings.mockResolvedValue(withOwnLimit(20 * MB))
      expect(await getEffectiveMaxUploadBytes('org-1')).toBe(20 * MB)
      expect(await getEffectiveMaxUploadBytes('org-1')).toBe(20 * MB)
      expect(getOrgSettings).toHaveBeenCalledTimes(1)

      // Another organization is its own entry, never the first one's answer.
      getOrgSettings.mockResolvedValue(withOwnLimit(undefined))
      expect(await getEffectiveMaxUploadBytes('org-2')).toBe(100 * MB)

      getOrgSettings.mockResolvedValue(withOwnLimit(60 * MB))
      await setMaxUploadFileBytes(platformSession(), 'org-1', 60 * MB)
      expect(await getEffectiveMaxUploadBytes('org-1')).toBe(60 * MB)
    })
  })

  describe('assertFileSizeAllowed', () => {
    it("refuses a file over the organization's limit with a 413 naming it in MB", async () => {
      getOrgSettings.mockResolvedValue(withOwnLimit(20 * MB))
      await expect(assertFileSizeAllowed('org-1', 20 * MB + 1, 'plan.pdf')).rejects.toMatchObject({
        status: 413,
        code: 'FILE_TOO_LARGE',
        message: 'File exceeds the maximum upload size of 20 MB',
        details: { fileSize: 20 * MB + 1, maxSizeBytes: 20 * MB },
      })
    })

    it('admits a file exactly at the limit, and one an org raised above the default', async () => {
      getOrgSettings.mockResolvedValue(withOwnLimit(200 * MB))
      await expect(assertFileSizeAllowed('org-1', 200 * MB, 'plan.pdf')).resolves.toBeUndefined()
      await expect(assertFileSizeAllowed('org-1', 150 * MB, 'plan.pdf')).resolves.toBeUndefined()
    })

    it('measures a model against BIM_MAX_IFC_BYTES, which no organization value lowers', async () => {
      getOrgSettings.mockResolvedValue(withOwnLimit(5 * MB))
      await expect(assertFileSizeAllowed('org-1', 200 * MB, 'haus.ifc')).resolves.toBeUndefined()
      await expect(assertFileSizeAllowed('org-1', 251 * MB, 'haus.ifc')).rejects.toMatchObject({
        status: 413,
        message: 'File exceeds the maximum upload size of 250 MB',
      })
      await expect(assertFileSizeAllowed('org-1', 6 * MB, 'plan.pdf')).rejects.toMatchObject({
        status: 413,
      })
    })

    it('states a fractional limit as the decimal MB it was set in', async () => {
      getOrgSettings.mockResolvedValue(withOwnLimit(2.5 * MB))
      await expect(assertFileSizeAllowed('org-1', 3 * MB, 'scan.pdf')).rejects.toMatchObject({
        message: 'File exceeds the maximum upload size of 2.5 MB',
      })
    })
  })

  describe('setMaxUploadFileBytes', () => {
    it('stores the value, invalidates, and audits it', async () => {
      const result = await setMaxUploadFileBytes(platformSession(), 'org-1', 200 * MB)

      expect(result).toEqual({ maxUploadFileBytes: 200 * MB, effectiveMaxUploadFileBytes: 200 * MB })
      expect(updatePlatformOwnedOrgSettings).toHaveBeenCalledWith(platformSession(), 'org-1', {
        settings: { [MAX_UPLOAD_FILE_SETTING]: 200 * MB },
      })
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'org.upload_limit.updated',
          organizationId: 'org-1',
          targetId: 'org-1',
          metadata: { maxUploadFileBytes: 200 * MB },
        })
      )
    })

    it('clears with null, back to the default, recorded as 0', async () => {
      const result = await setMaxUploadFileBytes(platformSession(), 'org-1', null)

      expect(result).toEqual({ maxUploadFileBytes: null, effectiveMaxUploadFileBytes: 100 * MB })
      expect(updatePlatformOwnedOrgSettings).toHaveBeenCalledWith(platformSession(), 'org-1', {
        settings: { [MAX_UPLOAD_FILE_SETTING]: null },
      })
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { maxUploadFileBytes: 0 } })
      )
    })

    it.each([
      ['above the transport ceiling', 250 * MB + 1],
      ['below 1 MB', MB - 1],
      ['fractional bytes', 2.5],
    ])('refuses a value %s with a 422 naming the range', async (_label, bytes) => {
      await expect(setMaxUploadFileBytes(platformSession(), 'org-1', bytes)).rejects.toMatchObject({
        status: 422,
        message:
          'Upload limit must be between 1 MB and 250 MB, the largest request this deployment accepts',
      })
      expect(updatePlatformOwnedOrgSettings).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    it('accepts exactly the ceiling', async () => {
      await expect(setMaxUploadFileBytes(platformSession(), 'org-1', 250 * MB)).resolves.toEqual({
        maxUploadFileBytes: 250 * MB,
        effectiveMaxUploadFileBytes: 250 * MB,
      })
    })

    it('refuses an organization Grid has never heard of', async () => {
      findOrganization.mockResolvedValue(null)
      await expect(setMaxUploadFileBytes(platformSession(), 'org-typo', 50 * MB)).rejects.toMatchObject({
        status: 404,
      })
      expect(updatePlatformOwnedOrgSettings).not.toHaveBeenCalled()
    })

    it('refuses a caller without the platform permission before probing the organization', async () => {
      requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
      await expect(setMaxUploadFileBytes(platformSession(), 'org-typo', 50 * MB)).rejects.toMatchObject({
        status: 403,
      })
      expect(aggregateStorageUsage).not.toHaveBeenCalled()
      expect(findOrganization).not.toHaveBeenCalled()
      expect(updatePlatformOwnedOrgSettings).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })
  })
})
