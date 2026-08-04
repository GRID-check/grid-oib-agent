/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listOrganizationFeatureFlags = vi.fn()

vi.mock('./client', () => ({
  getWorkOS: () => ({ featureFlags: { listOrganizationFeatureFlags } }),
}))

import { _clearFeatureFlagCache, isMemoryReflectionEnabled, isOrgFeatureEnabled, MEMORY_REFLECTION_FLAG } from './feature-flags'

beforeEach(async () => {
  vi.stubEnv('WORKOS_API_KEY', 'sk_test')
  await _clearFeatureFlagCache('org-1')
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

describe('isMemoryReflectionEnabled', () => {
  it('defaults to on when flag enforcement is off and the env var is unset', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', '')
    await expect(isMemoryReflectionEnabled('org-1')).resolves.toBe(true)
    // No WorkOS round-trip in non-enforced mode.
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('is on for anonymous (org-less) requests when enforcement is off', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', '')
    await expect(isMemoryReflectionEnabled(undefined)).resolves.toBe(true)
  })

  it('honours an explicit GRID_MEMORY_REFLECTION_ENABLED=false when enforcement is off', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', '')
    vi.stubEnv('GRID_MEMORY_REFLECTION_ENABLED', 'false')
    await expect(isMemoryReflectionEnabled('org-1')).resolves.toBe(false)
  })

  it('follows the per-org WorkOS flag when enforcement is on', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    listOrganizationFeatureFlags.mockResolvedValue({ data: [{ slug: MEMORY_REFLECTION_FLAG }] })
    await expect(isMemoryReflectionEnabled('org-1')).resolves.toBe(true)
  })

  it('fails closed when enforcement is on and the org lacks the flag', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    listOrganizationFeatureFlags.mockResolvedValue({ data: [{ slug: 'other' }] })
    await expect(isMemoryReflectionEnabled('org-1')).resolves.toBe(false)
  })

  it('fails closed for org-less requests when enforcement is on', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    await expect(isMemoryReflectionEnabled(undefined)).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })
})
