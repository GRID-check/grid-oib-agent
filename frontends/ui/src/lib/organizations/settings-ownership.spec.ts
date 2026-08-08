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

// Mocked at the predicate rather than at WorkOS, because what these tests are
// about is whether the platform write path CONSULTS it — the real
// `isPlatformOwner` is covered in `authz/platform.spec.ts`.
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

import { ForbiddenError } from '@/lib/api/errors'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { PLATFORM_OWNED_SETTINGS } from '@/lib/db/schema'
import type { GridSession } from '@/lib/auth/types'
import { updateOrgSettings, updatePlatformOwnedOrgSettings } from './service'

const OWNER = { userId: 'user-1', email: 'ops@grid.example' } as GridSession
const TENANT_ADMIN = { userId: 'user-2', email: 'admin@tenant.example' } as GridSession

/**
 * Who owns which key in the `organizations.settings` bag.
 *
 * The bag has one write path and no schema, so before this the owner of a key was
 * expressed only by which service function a caller reached for.
 * `setStorageQuota` is platform-only by construction — explicit
 * `organizationId`, a refusal below current usage, `requirePlatformOwner` on the
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
    isPlatformOwner.mockResolvedValue(true)
  })

  it.each([...PLATFORM_OWNED_SETTINGS])('refuses %s from the tenant write path', async (key) => {
    await expect(
      updateOrgSettings('org-1', { settings: { [key]: 999_999_999_999 } })
    ).rejects.toBeInstanceOf(ForbiddenError)
    // Nothing written at all — not the offending key, and not the rest of a patch
    // that happened to carry it.
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('names every offending key, so a rejected patch is one round trip', async () => {
    await expect(
      updateOrgSettings('org-1', { settings: { storageQuotaBytes: 1, zdrOnly: true } })
    ).rejects.toThrow(/storageQuotaBytes/)
  })

  it('still accepts the keys the tenant does own', async () => {
    await updateOrgSettings('org-1', { settings: { zdrOnly: true, webSearchEnabled: false } })
    expect(upsertOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { zdrOnly: true, webSearchEnabled: false } })
    )
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
    isPlatformOwner.mockResolvedValue(false)
    await expect(
      updatePlatformOwnedOrgSettings(TENANT_ADMIN, 'org-1', {
        settings: { storageQuotaBytes: 999_999_999_999 },
      })
    ).rejects.toBeInstanceOf(PlatformAccessDeniedError)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('refuses an absent session', async () => {
    isPlatformOwner.mockResolvedValue(false)
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
