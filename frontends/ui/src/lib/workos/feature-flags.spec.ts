/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listOrganizationFeatureFlags = vi.fn()

/**
 * The SDK returns an `AutoPaginatable`, not a plain list: `data` is the FIRST
 * page (10 flags by default) and `autoPagination()` follows the cursor. The
 * double mirrors both, so a reader that only maps `data` fails here instead of
 * in production, where it silently reports every flag past the tenth as off.
 */
function paginated(...pages: { slug: string }[][]) {
  return {
    data: pages[0] ?? [],
    autoPagination: async () => pages.flat(),
  }
}

vi.mock('./client', () => ({
  getWorkOS: () => ({ featureFlags: { listOrganizationFeatureFlags } }),
}))

import { FEATURE_FLAGS } from '@/lib/authz/feature-flags'
import { TransientAuthzError } from '@/lib/authz/errors'
import {
  _clearFeatureFlagCache,
  enabledPostAnswerStages,
  isDeepResearchEnabledForOrg,
  isMemoryReflectionEnabled,
  isOrgFeatureEnabled,
  isProjectMailInboxEnabledForOrg,
  isTaskAutomationEnabledForOrg,
  POST_ANSWER_STAGE_FLAGS,
} from './feature-flags'

const MEMORY_REFLECTION = FEATURE_FLAGS.memoryReflection

beforeEach(async () => {
  // Where people sign in — every deployed stack. The anonymous deployment is
  // its own describe block below.
  vi.stubEnv('REQUIRE_AUTH', 'true')
  vi.stubEnv('WORKOS_API_KEY', 'sk_test')
  await _clearFeatureFlagCache('org-1')
  listOrganizationFeatureFlags.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isOrgFeatureEnabled', () => {
  it('is true when the slug is among the org’s enabled flags', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION }, { slug: 'other' }]))
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION, 'org-1')).resolves.toBe(true)
    expect(listOrganizationFeatureFlags).toHaveBeenCalledWith({ organizationId: 'org-1' })
  })

  it('reads past the first page, because the endpoint returns ten at a time', async () => {
    // The defect: `data` alone is one page. Production serves an organization
    // more than ten flags, and a reader that stops at the first page reports
    // whatever sorts after it as OFF — silently, and per organization.
    listOrganizationFeatureFlags.mockResolvedValue(
      paginated(Array.from({ length: 10 }, (_, i) => ({ slug: `filler-${i}` })), [
        { slug: MEMORY_REFLECTION },
      ]),
    )

    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION, 'org-1')).resolves.toBe(true)
  })

  it('asks for no explicit limit, or the SDK short-circuits to one page', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION }]))

    await isOrgFeatureEnabled(MEMORY_REFLECTION, 'org-1')

    expect(listOrganizationFeatureFlags).toHaveBeenCalledWith({ organizationId: 'org-1' })
  })

  it('is false when the slug is not enabled for the org', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION, 'org-1')).resolves.toBe(false)
  })

  it('is false when there is no org, whatever kind the flag is', async () => {
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION, null)).resolves.toBe(false)
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.deepResearch, undefined)).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('is false when there is no WorkOS API key', async () => {
    vi.stubEnv('WORKOS_API_KEY', '')
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION, 'org-1')).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('fails closed when evaluation throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    listOrganizationFeatureFlags.mockRejectedValue(new Error('feature not on plan'))
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION, 'org-1')).resolves.toBe(false)
  })

  it('caches per org (no second WorkOS call within the TTL)', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION }]))
    await isOrgFeatureEnabled(MEMORY_REFLECTION, 'org-1')
    await isOrgFeatureEnabled(MEMORY_REFLECTION, 'org-1')
    expect(listOrganizationFeatureFlags).toHaveBeenCalledTimes(1)
  })
})

describe('a deployment that authenticates nobody (REQUIRE_AUTH not true)', () => {
  beforeEach(() => {
    vi.stubEnv('REQUIRE_AUTH', 'false')
  })

  it('serves every rollout, with or without an organization, and asks WorkOS nothing', async () => {
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION, 'org-1')).resolves.toBe(true)
    await expect(isMemoryReflectionEnabled(undefined)).resolves.toBe(true)
    await expect(enabledPostAnswerStages(undefined)).resolves.toEqual(['memory_reflection', 'follow_ups'])
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('withholds every entitlement — deep research and tasks included', async () => {
    await expect(isDeepResearchEnabledForOrg(undefined)).resolves.toBe(false)
    await expect(isTaskAutomationEnabledForOrg('org-1')).resolves.toBe(false)
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.skills, 'org-1')).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('ignores a WorkOS key that happens to be configured', async () => {
    // A key set for Vault or the audit log does not make an anonymous stack a
    // tenant one: there is still nobody signed in to hold an entitlement.
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: FEATURE_FLAGS.deepResearch }]))
    await expect(isDeepResearchEnabledForOrg('org-1')).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })
})

describe('the capabilities the agent reads per turn', () => {
  it('deep research is OFF for a caller with no organization — it used to fail open', async () => {
    await expect(isDeepResearchEnabledForOrg(undefined)).resolves.toBe(false)
    await expect(isDeepResearchEnabledForOrg(null)).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('tasks are OFF for a caller with no organization, the same way', async () => {
    await expect(isTaskAutomationEnabledForOrg(undefined)).resolves.toBe(false)
  })

  it('both follow the organization’s flag', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: FEATURE_FLAGS.deepResearch }]))
    await expect(isDeepResearchEnabledForOrg('org-1')).resolves.toBe(true)
    await expect(isTaskAutomationEnabledForOrg('org-1')).resolves.toBe(false)
  })
})

describe('isMemoryReflectionEnabled', () => {
  it('follows the per-org WorkOS flag', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION }]))
    await expect(isMemoryReflectionEnabled('org-1')).resolves.toBe(true)
  })

  it('fails closed when the org lacks the flag', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
    await expect(isMemoryReflectionEnabled('org-1')).resolves.toBe(false)
  })

  it('reads no environment fallback — GRID_MEMORY_REFLECTION_ENABLED is gone', async () => {
    vi.stubEnv('GRID_MEMORY_REFLECTION_ENABLED', 'true')
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
    await expect(isMemoryReflectionEnabled('org-1')).resolves.toBe(false)
  })
})

describe('enabledPostAnswerStages', () => {
  it('mirrors the backend stage ids, not the flag slugs', () => {
    // A stage the backend declares but this registry omits can never be
    // switched on, so the ids have to be the StageSpec ids verbatim.
    expect(POST_ANSWER_STAGE_FLAGS.map((stage) => stage.id)).toEqual(['memory_reflection', 'follow_ups'])
  })

  it('lists a stage whose flag is on for the org', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION }]))
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual(['memory_reflection'])
  })

  it('omits a stage whose flag is off — the kill switch, per turn', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual([])
  })

  it('agrees with isMemoryReflectionEnabled — one source of truth', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
    const [viaStages, viaLegacy] = [await enabledPostAnswerStages('org-1'), await isMemoryReflectionEnabled('org-1')]
    expect(viaStages.includes('memory_reflection')).toBe(viaLegacy)
  })
})

describe('isProjectMailInboxEnabledForOrg, the session-less half', () => {
  it('is off without an organization', async () => {
    await expect(isProjectMailInboxEnabledForOrg(null)).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('follows the per-org flag', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'project-mail-inbox' }]))
    await expect(isProjectMailInboxEnabledForOrg('org-1')).resolves.toBe(true)
    await _clearFeatureFlagCache('org-1')
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'skills' }]))
    await expect(isProjectMailInboxEnabledForOrg('org-1')).resolves.toBe(false)
  })

  it('reads every page, so a flag past the tenth is not read as off', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(
      paginated([{ slug: 'a' }], [{ slug: 'b' }, { slug: 'project-mail-inbox' }])
    )
    await expect(isProjectMailInboxEnabledForOrg('org-1')).resolves.toBe(true)
  })

  // "Off" bounces the mail; "could not ask" must make the sender's server retry.
  it('throws TransientAuthzError when WorkOS cannot be asked', async () => {
    listOrganizationFeatureFlags.mockRejectedValue(new Error('workos down'))
    await expect(isProjectMailInboxEnabledForOrg('org-1')).rejects.toBeInstanceOf(TransientAuthzError)
  })

  it('throws TransientAuthzError without an API key, rather than answering off', async () => {
    vi.stubEnv('WORKOS_API_KEY', '')
    await expect(isProjectMailInboxEnabledForOrg('org-1')).rejects.toBeInstanceOf(TransientAuthzError)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('is off where nobody signs in, and never asks WorkOS', async () => {
    vi.stubEnv('REQUIRE_AUTH', 'false')
    await expect(isProjectMailInboxEnabledForOrg('org-1')).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })
})
