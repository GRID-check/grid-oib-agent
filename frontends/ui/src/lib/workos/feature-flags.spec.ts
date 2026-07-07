import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listOrganizationFeatureFlags = vi.fn()

vi.mock('./client', () => ({
  getWorkOS: () => ({ featureFlags: { listOrganizationFeatureFlags } }),
}))

import { _clearFeatureFlagCache, isOrgFeatureEnabled, MEMORY_REFLECTION_FLAG } from './feature-flags'

beforeEach(() => {
  vi.stubEnv('WORKOS_API_KEY', 'sk_test')
  _clearFeatureFlagCache()
  listOrganizationFeatureFlags.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isOrgFeatureEnabled', () => {
  it('is true when the slug is among the org’s enabled flags', async () => {
    listOrganizationFeatureFlags.mockResolvedValue({ data: [{ slug: MEMORY_REFLECTION_FLAG }, { slug: 'other' }] })
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, 'org-1')).resolves.toBe(true)
    expect(listOrganizationFeatureFlags).toHaveBeenCalledWith({ organizationId: 'org-1' })
  })

  it('is false when the slug is not enabled for the org', async () => {
    listOrganizationFeatureFlags.mockResolvedValue({ data: [{ slug: 'other' }] })
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, 'org-1')).resolves.toBe(false)
  })

  it('returns the default (fail-closed) when there is no org', async () => {
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, null)).resolves.toBe(false)
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, undefined, true)).resolves.toBe(true)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('returns the default when there is no WorkOS API key', async () => {
    vi.stubEnv('WORKOS_API_KEY', '')
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, 'org-1')).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('fails closed to the default when evaluation throws', async () => {
    listOrganizationFeatureFlags.mockRejectedValue(new Error('feature not on plan'))
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, 'org-1', false)).resolves.toBe(false)
  })

  it('caches per org (no second WorkOS call within the TTL)', async () => {
    listOrganizationFeatureFlags.mockResolvedValue({ data: [{ slug: MEMORY_REFLECTION_FLAG }] })
    await isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, 'org-1')
    await isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, 'org-1')
    expect(listOrganizationFeatureFlags).toHaveBeenCalledTimes(1)
  })
})
