/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listOrganizationFeatureFlags = vi.fn()

vi.mock('./client', () => ({
  getWorkOS: () => ({ featureFlags: { listOrganizationFeatureFlags } }),
}))

import {
  _clearFeatureFlagCache,
  enabledPostAnswerStages,
  isMemoryReflectionEnabled,
  isOrgFeatureEnabled,
  MEMORY_REFLECTION_FLAG,
  POST_ANSWER_STAGE_FLAGS,
} from './feature-flags'

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

describe('enabledPostAnswerStages', () => {
  it('mirrors the backend stage ids, not the flag slugs', () => {
    // A stage the backend declares but this registry omits can never be
    // switched on, so the ids have to be the StageSpec ids verbatim.
    expect(POST_ANSWER_STAGE_FLAGS.map((stage) => stage.id)).toContain('memory_reflection')
  })

  it('lists a stage whose flag is on for the org', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    listOrganizationFeatureFlags.mockResolvedValue({ data: [{ slug: MEMORY_REFLECTION_FLAG }] })
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual(['memory_reflection'])
  })

  it('omits a stage whose flag is off — the kill switch, per turn', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    listOrganizationFeatureFlags.mockResolvedValue({ data: [{ slug: 'other' }] })
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual([])
  })

  it('follows the env fallback when enforcement is off', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', '')
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual(['memory_reflection', 'follow_ups'])
    vi.stubEnv('GRID_MEMORY_REFLECTION_ENABLED', 'false')
    vi.stubEnv('GRID_STAGE_FOLLOW_UPS_ENABLED', 'false')
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual([])
  })

  it('serves follow_ups by default now that the card it replaces is retired', async () => {
    // `follow_ups` shipped `defaultOn: false`, as every new stage does. Slice 4
    // retired the in-answer `follow_ups` CARD (`SYSTEM_CARD_TYPES`), so the
    // stage is the only thing that produces follow-up questions — and a
    // deployment without the WorkOS flag product reads `defaultOn`, so leaving
    // it false there would mean a Grid with none at all and nothing to switch
    // on. Pinned because the value is one word and the consequence is a missing
    // feature nobody gets an error about.
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', '')
    await expect(enabledPostAnswerStages('org-1')).resolves.toContain('follow_ups')

    // Still switchable off without a deploy, which is the half that must not be
    // lost when a default flips.
    vi.stubEnv('GRID_STAGE_FOLLOW_UPS_ENABLED', 'false')
    await expect(enabledPostAnswerStages('org-1')).resolves.not.toContain('follow_ups')
  })

  it('agrees with isMemoryReflectionEnabled — one source of truth', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    listOrganizationFeatureFlags.mockResolvedValue({ data: [{ slug: 'other' }] })
    const [viaStages, viaLegacy] = [await enabledPostAnswerStages('org-1'), await isMemoryReflectionEnabled('org-1')]
    expect(viaStages.includes('memory_reflection')).toBe(viaLegacy)
  })
})
