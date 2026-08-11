/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  FEATURE_FLAGS,
  ifcModelsEnvEnabled,
  isFeatureEnabled,
  isIfcModelsEnabled,
  isSkillsEnabled,
  requireFeature,
  requireSkillsEnabled,
} from './feature-flags'

const FLAG = FEATURE_FLAGS.modelConfiguration

describe('feature flags (WorkOS-native, JWT claim)', () => {
  afterEach(() => {
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
  })

  it('registry contains the known flags with their WorkOS slugs', () => {
    expect(FEATURE_FLAGS.modelConfiguration).toBe('runtime-model-config')
    expect(FEATURE_FLAGS.deepResearch).toBe('deep-research')
    expect(FEATURE_FLAGS.keyboardShortcuts).toBe('keyboard-shortcuts')
  })

  it('enforced: keyboard shortcuts follow the org claim like any other flag', () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    const flag = FEATURE_FLAGS.keyboardShortcuts
    expect(isFeatureEnabled({ featureFlags: [flag] }, flag)).toBe(true)
    expect(isFeatureEnabled({ featureFlags: [] }, flag)).toBe(false)
  })

  it('everything stays enabled while enforcement is off (default)', () => {
    expect(isFeatureEnabled({ featureFlags: null }, FLAG)).toBe(true)
    expect(isFeatureEnabled({ featureFlags: [] }, FLAG)).toBe(true)
    expect(requireFeature({ featureFlags: null }, FLAG)).toBeNull()
  })

  it('enforced: only sessions carrying the flag slug pass', () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    expect(isFeatureEnabled({ featureFlags: [FLAG] }, FLAG)).toBe(true)
    expect(isFeatureEnabled({ featureFlags: ['other-flag'] }, FLAG)).toBe(false)
    expect(isFeatureEnabled({ featureFlags: [] }, FLAG)).toBe(false)
  })

  it('enforced: a token without the claim fails closed (stale session)', () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    expect(isFeatureEnabled({ featureFlags: null }, FLAG)).toBe(false)
  })

  it('requireFeature returns a stable-coded 403', async () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    const res = requireFeature({ featureFlags: [] }, FLAG)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: 'feature-disabled', feature: FLAG })
  })
})

describe('organization-archiv flag (standard WorkOS flag, ADR-0024)', () => {
  afterEach(() => {
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
  })

  it('registry carries the organization-archiv slug', () => {
    expect(FEATURE_FLAGS.orgArchiv).toBe('organization-archiv')
  })

  it('unenforced: available to all (fail-open like every flag) — no env var involved', () => {
    expect(isFeatureEnabled({ featureFlags: null }, FEATURE_FLAGS.orgArchiv)).toBe(true)
    expect(isFeatureEnabled({ featureFlags: [] }, FEATURE_FLAGS.orgArchiv)).toBe(true)
  })

  it('enforced: gated per-org by the WorkOS flag claim', () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    expect(
      isFeatureEnabled({ featureFlags: [FEATURE_FLAGS.orgArchiv] }, FEATURE_FLAGS.orgArchiv)
    ).toBe(true)
    expect(isFeatureEnabled({ featureFlags: [] }, FEATURE_FLAGS.orgArchiv)).toBe(false)
    expect(isFeatureEnabled({ featureFlags: null }, FEATURE_FLAGS.orgArchiv)).toBe(false)
  })

  it('requireFeature: null when allowed, stable-coded 403 when off', async () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    expect(
      requireFeature({ featureFlags: [FEATURE_FLAGS.orgArchiv] }, FEATURE_FLAGS.orgArchiv)
    ).toBeNull()

    const res = requireFeature({ featureFlags: [] }, FEATURE_FLAGS.orgArchiv)
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: 'feature-disabled', feature: 'organization-archiv' })
  })
})

describe('ifc-models — default ON, with its own off switch', () => {
  afterEach(() => {
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
    delete process.env.GRID_IFC_MODELS_ENABLED
  })

  it('registry carries the ifc-models slug', () => {
    expect(FEATURE_FLAGS.ifcModels).toBe('ifc-models')
  })

  it('unenforced and unset: ON', () => {
    expect(isIfcModelsEnabled({ featureFlags: null })).toBe(true)
    expect(isIfcModelsEnabled({ featureFlags: [] })).toBe(true)
  })

  it('unenforced: an explicit falsey value withdraws the feature', () => {
    // The point of having its own variable rather than riding the fail-open
    // `isFeatureEnabled` path: a deployment can turn THIS off without switching
    // on flag enforcement for every other feature at the same time.
    for (const value of ['false', 'FALSE', ' false ', '0', 'no', 'off']) {
      process.env.GRID_IFC_MODELS_ENABLED = value
      expect(ifcModelsEnvEnabled(), `value ${JSON.stringify(value)}`).toBe(false)
      expect(isIfcModelsEnabled({ featureFlags: [FEATURE_FLAGS.ifcModels] })).toBe(false)
    }
  })

  it('unenforced: anything else leaves it on', () => {
    for (const value of ['', 'true', 'TRUE', '1', 'yes']) {
      process.env.GRID_IFC_MODELS_ENABLED = value
      expect(ifcModelsEnvEnabled(), `value ${JSON.stringify(value)}`).toBe(true)
    }
  })

  it('enforced: the per-org WorkOS claim decides and the env var is ignored', () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    process.env.GRID_IFC_MODELS_ENABLED = 'true'
    expect(isIfcModelsEnabled({ featureFlags: [FEATURE_FLAGS.ifcModels] })).toBe(true)
    expect(isIfcModelsEnabled({ featureFlags: [] })).toBe(false)
    // A token minted before the flag existed must not inherit the env default.
    expect(isIfcModelsEnabled({ featureFlags: null })).toBe(false)
  })
})

describe('isSkillsEnabled (dark-launch gate, ADR-0046)', () => {
  afterEach(() => {
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
    delete process.env.GRID_SKILLS_ENABLED
  })

  it('registry carries the skills slug', () => {
    expect(FEATURE_FLAGS.skills).toBe('skills')
  })

  it('unenforced and without the env opt-in: OFF, unlike an ordinary flag', () => {
    // The point of a dark-launch gate: every other flag fails OPEN while
    // enforcement is off, so only an explicit env opt-in can reveal this one.
    expect(isSkillsEnabled({ featureFlags: [FEATURE_FLAGS.skills] })).toBe(false)
    expect(isSkillsEnabled({ featureFlags: null })).toBe(false)
  })

  it('unenforced with GRID_SKILLS_ENABLED=true: on for everyone', () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    expect(isSkillsEnabled({ featureFlags: [] })).toBe(true)
    expect(isSkillsEnabled({ featureFlags: null })).toBe(true)
  })

  it('enforced: the per-org WorkOS flag decides, and the env var stops counting', () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    process.env.GRID_SKILLS_ENABLED = 'true'
    expect(isSkillsEnabled({ featureFlags: [FEATURE_FLAGS.skills] })).toBe(true)
    expect(isSkillsEnabled({ featureFlags: [] })).toBe(false)
    expect(isSkillsEnabled({ featureFlags: null })).toBe(false)
  })

  it('requireSkillsEnabled: null when allowed, stable-coded 403 when off', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    expect(requireSkillsEnabled({ featureFlags: [] })).toBeNull()

    delete process.env.GRID_SKILLS_ENABLED
    const res = requireSkillsEnabled({ featureFlags: [] })
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: 'feature-disabled', feature: 'skills' })
  })
})
