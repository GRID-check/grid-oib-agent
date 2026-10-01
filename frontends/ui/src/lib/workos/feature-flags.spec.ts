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
  enabledSlugsForOrg,
  isMemoryReflectionEnabled,
  isOrgFeatureEnabled,
  isProjectMailInboxEnabledForOrg,
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
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION_FLAG }, { slug: 'other' }]))
    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, 'org-1')).resolves.toBe(true)
    expect(listOrganizationFeatureFlags).toHaveBeenCalledWith({ organizationId: 'org-1' })
  })

  it('reads past the first page, because the endpoint returns ten at a time', async () => {
    // The defect: `data` alone is one page. Production serves an organization
    // more than ten flags, and a reader that stops at the first page reports
    // whatever sorts after it as OFF — silently, and per organization.
    listOrganizationFeatureFlags.mockResolvedValue(
      paginated(Array.from({ length: 10 }, (_, i) => ({ slug: `filler-${i}` })), [
        { slug: MEMORY_REFLECTION_FLAG },
      ]),
    )

    await expect(isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, 'org-1')).resolves.toBe(true)
  })

  it('asks for no explicit limit, or the SDK short-circuits to one page', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION_FLAG }]))

    await isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, 'org-1')

    expect(listOrganizationFeatureFlags).toHaveBeenCalledWith({ organizationId: 'org-1' })
  })

  it('is false when the slug is not enabled for the org', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
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
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION_FLAG }]))
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
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION_FLAG }]))
    await expect(isMemoryReflectionEnabled('org-1')).resolves.toBe(true)
  })

  it('fails closed when enforcement is on and the org lacks the flag', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
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
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: MEMORY_REFLECTION_FLAG }]))
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual(['memory_reflection'])
  })

  it('omits a stage whose flag is off — the kill switch, per turn', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
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
    // retired the in-answer `follow_ups` CARD (deleted by ADR-0069), so the
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
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
    const [viaStages, viaLegacy] = [await enabledPostAnswerStages('org-1'), await isMemoryReflectionEnabled('org-1')]
    expect(viaStages.includes('memory_reflection')).toBe(viaLegacy)
  })
})

describe('the slug is typed, so it cannot trade places with the org id (#787)', () => {
  it('does not compile with the arguments swapped', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: FEATURE_FLAGS.skills }]))
    // The pinned-session bug: `isOrgFeatureEnabled(orgId, slug)`. Both are
    // strings, so it compiled and asked WorkOS about an organization named
    // after the flag. `tsc` now refuses it; this line is the proof.
    // @ts-expect-error an organization id is not a FeatureFlagSlug
    await isOrgFeatureEnabled('org-1', FEATURE_FLAGS.skills)
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.skills, 'org-1')).resolves.toBe(true)
  })

  it('registers every slug the post-answer stages read, so provisioning checks them', () => {
    const registry: readonly string[] = Object.values(FEATURE_FLAGS)
    for (const stage of POST_ANSWER_STAGE_FLAGS) expect(registry).toContain(stage.flag)
  })
})

describe('enabledSlugsForOrg — the full-set reader', () => {
  it('returns every enabled slug, past the first page', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(
      paginated([{ slug: 'a' }], [{ slug: 'b' }, { slug: 'project-mail-inbox' }])
    )
    await expect(enabledSlugsForOrg('org-1')).resolves.toEqual(new Set(['a', 'b', 'project-mail-inbox']))
  })

  it('throws rather than deciding what a failure means', async () => {
    listOrganizationFeatureFlags.mockRejectedValue(new Error('workos down'))
    await expect(enabledSlugsForOrg('org-1')).rejects.toThrow('workos down')
  })

  it('throws without an API key, where the single-flag reader answers its default', async () => {
    vi.stubEnv('WORKOS_API_KEY', '')
    await expect(enabledSlugsForOrg('org-1')).rejects.toThrow(/WORKOS_API_KEY/)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })
})

describe('isProjectMailInboxEnabledForOrg — the session-less half (E1, C2)', () => {
  it('is off without an organization', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    await expect(isProjectMailInboxEnabledForOrg(null)).resolves.toBe(false)
  })

  it('follows the per-org flag under enforcement', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'project-mail-inbox' }]))
    await expect(isProjectMailInboxEnabledForOrg('org-1')).resolves.toBe(true)
    await _clearFeatureFlagCache('org-1')
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'skills' }]))
    await expect(isProjectMailInboxEnabledForOrg('org-1')).resolves.toBe(false)
  })

  it('throws TransientAuthzError when WorkOS cannot be asked: a retry, not "off"', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    listOrganizationFeatureFlags.mockRejectedValue(new Error('workos down'))
    await expect(isProjectMailInboxEnabledForOrg('org-1')).rejects.toBeInstanceOf(TransientAuthzError)
  })

  it('follows the opt-in env variable without enforcement, and never asks WorkOS', async () => {
    await expect(isProjectMailInboxEnabledForOrg('org-1')).resolves.toBe(false)
    vi.stubEnv('GRID_PROJECT_MAIL_INBOX_ENABLED', 'true')
    await expect(isProjectMailInboxEnabledForOrg('org-1')).resolves.toBe(true)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })
})
