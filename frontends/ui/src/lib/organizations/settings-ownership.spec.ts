import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const findOrganization = vi.fn()
const upsertOrganization = vi.fn()
vi.mock('./repository', () => ({
  findOrganization: (...args: unknown[]) => findOrganization(...args),
  upsertOrganization: (...args: unknown[]) => upsertOrganization(...args),
}))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/cache', () => ({ getCached: vi.fn(), invalidateCached: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({
  isOrgFeatureEnabled: vi.fn(),
  WEB_SEARCH_FLAG: 'web-search',
}))

// Stubbed at the guard rather than at WorkOS, because what these tests are about
// is whether the platform write path CALLS it — whether the guard decides
// correctly is `authz/platform.spec.ts`. `importOriginal` and a spread, matching
// the three route specs that already mock this module, which is also what keeps
// the real `PlatformAccessDeniedError` importable below.
const requirePlatformPermission = vi.fn()
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/authz/platform')>()
  return { ...original, requirePlatformPermission: (s: unknown) => requirePlatformPermission(s) }
})

import { ForbiddenError } from '@/lib/api/errors'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { PLATFORM_OWNED_SETTINGS } from '@/lib/db/schema'
import type { GridSession } from '@/lib/auth/types'
import { updateOrgSettings, updatePlatformOwnedOrgSettings, writeDedicatedOrgSetting } from './service'

const OWNER = { userId: 'user-1', email: 'ops@grid.example' } as GridSession
const TENANT_ADMIN = { userId: 'user-2', email: 'admin@tenant.example' } as GridSession

/**
 * Who owns which key in the `organizations.settings` bag.
 *
 * The bag has one write path and no schema, so before this the owner of a key was
 * expressed only by which service function a caller reached for.
 * `setStorageQuota` is platform-only by construction — explicit
 * `organizationId`, a refusal below current usage, `requirePlatformPermission` on the
 * route — and all of it was bypassable through `PUT /api/organization/settings`,
 * which merges arbitrary keys under `org:settings:manage`, a permission tenant
 * admins hold. A tenant could raise its own quota, which makes it not a quota.
 *
 * The guard lives in the merge every writer passes through, so a new tenant-facing
 * endpoint inherits it rather than having to remember it.
 */
describe('platform-owned settings keys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findOrganization.mockResolvedValue({
      workosOrganizationId: 'org-1',
      displayName: null,
      defaultLocale: 'en',
      settings: {},
    })
    upsertOrganization.mockResolvedValue(undefined)
    requirePlatformPermission.mockResolvedValue(undefined)
  })

  it.each([...PLATFORM_OWNED_SETTINGS])('refuses %s from the tenant write path', async (key) => {
    await expect(
      updateOrgSettings('org-1', { settings: { [key]: 999_999_999_999 } })
    ).rejects.toBeInstanceOf(ForbiddenError)
    // Nothing written at all — not the offending key, and not the rest of a patch
    // that happened to carry it.
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('does not mistake inherited object properties for dedicated-route keys', async () => {
    await updateOrgSettings('org-1', { settings: { constructor: 'x', toString: 'y' } })
    expect(upsertOrganization).toHaveBeenCalled()
  })

  it('names every offending key, so a rejected patch is one round trip', async () => {
    await expect(
      updateOrgSettings('org-1', { settings: { storageQuotaBytes: 1, zdrOnly: true } })
    ).rejects.toThrow(/storageQuotaBytes/)
  })

  it('still accepts the keys the tenant does own', async () => {
    await updateOrgSettings('org-1', { settings: { chatEffort: 'low', webSearchEnabled: false } })
    expect(upsertOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { chatEffort: 'low', webSearchEnabled: false } })
    )
  })

  // Tenant-owned, but written only by its dedicated route: the generic merge
  // used to let `org:settings:manage` switch zero data retention off.
  it('refuses a key a dedicated route owns (zdrOnly), whatever its value', async () => {
    for (const zdrOnly of [false, true, 'no']) {
      await expect(updateOrgSettings('org-1', { settings: { zdrOnly } })).rejects.toThrow(
        /model-config\/zdr/
      )
    }
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  // ADR-0086: a malformed policy saved through the generic merge would read as
  // the suggested one, but an `enabled: false` with no audit trail would not.
  it('refuses the upload-screening policy from the generic merge', async () => {
    await expect(
      updateOrgSettings('org-1', { settings: { uploadScreening: { enabled: false } } })
    ).rejects.toThrow(/upload-screening/)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('writes a dedicated key through its own door, and only a declared one', async () => {
    await writeDedicatedOrgSetting('org-1', 'uploadScreening', { enabled: true })
    expect(upsertOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { uploadScreening: { enabled: true } } })
    )
    await expect(
      writeDedicatedOrgSetting('org-1', 'storageQuotaBytes' as unknown as 'zdrOnly', 1)
    ).rejects.toThrow(/not a dedicated setting/)
  })

  it('accepts a patch with no settings bag at all', async () => {
    await updateOrgSettings('org-1', { displayName: 'Renamed' })
    expect(upsertOrganization).toHaveBeenCalled()
  })

  // The escape is a distinctly-named function rather than a boolean argument,
  // so `grep` finds every platform write and nothing reaches the bypass by
  // passing `true`.
  it('lets the platform path write the same key', async () => {
    await updatePlatformOwnedOrgSettings(OWNER, 'org-1', {
      settings: { storageQuotaBytes: 42 },
    })
    expect(upsertOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { storageQuotaBytes: 42 } })
    )
  })

  /**
   * The escape enforces what its name claims.
   *
   * It used to take no session and rely on its one caller being routed through
   * `platformApiRoute`. That made the guard a property of the call graph rather
   * than of the function — and the hole it would reopen is precisely the one
   * `updateOrgSettings` was changed to close, so "there is only one caller today"
   * is not a defence. This test is what makes the second caller impossible to get
   * wrong.
   */
  it('refuses a caller who is not the platform owner', async () => {
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
    await expect(
      updatePlatformOwnedOrgSettings(TENANT_ADMIN, 'org-1', {
        settings: { storageQuotaBytes: 999_999_999_999 },
      })
    ).rejects.toBeInstanceOf(PlatformAccessDeniedError)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('refuses an absent session', async () => {
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
    await expect(
      updatePlatformOwnedOrgSettings(null, 'org-1', { settings: { storageQuotaBytes: 1 } })
    ).rejects.toBeInstanceOf(PlatformAccessDeniedError)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('merges rather than replaces, on both paths', async () => {
    findOrganization.mockResolvedValue({
      workosOrganizationId: 'org-1',
      displayName: null,
      defaultLocale: 'en',
      settings: { zdrOnly: true },
    })

    await updatePlatformOwnedOrgSettings(OWNER, 'org-1', {
      settings: { storageQuotaBytes: 42 },
    })
    expect(upsertOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { zdrOnly: true, storageQuotaBytes: 42 } })
    )
  })
})
