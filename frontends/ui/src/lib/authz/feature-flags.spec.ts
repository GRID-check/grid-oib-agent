import { afterEach, describe, expect, it } from 'vitest'
import {
  FEATURE_FLAGS,
  isFeatureEnabled,
  isWorkflowsEnabled,
  requireFeature,
  requireWorkflowsEnabled,
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

describe('isWorkflowsEnabled (dark-launch gate)', () => {
  afterEach(() => {
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
    delete process.env.GRID_WORKFLOWS_ENABLED
  })

  it('registry carries the workflows slug', () => {
    expect(FEATURE_FLAGS.workflows).toBe('workflows')
  })

  it('unenforced: default OFF, ignoring the JWT claim', () => {
    expect(isWorkflowsEnabled({ featureFlags: [FEATURE_FLAGS.workflows] })).toBe(false)
    expect(isWorkflowsEnabled({ featureFlags: null })).toBe(false)
  })

  it('unenforced: the GRID_WORKFLOWS_ENABLED env opt-in turns it on', () => {
    process.env.GRID_WORKFLOWS_ENABLED = 'true'
    expect(isWorkflowsEnabled({ featureFlags: [] })).toBe(true)
    expect(isWorkflowsEnabled({ featureFlags: null })).toBe(true)
  })

  it('enforced: follows the per-org WorkOS flag, not the env var', () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    process.env.GRID_WORKFLOWS_ENABLED = 'true' // ignored while enforcement is on
    expect(isWorkflowsEnabled({ featureFlags: [FEATURE_FLAGS.workflows] })).toBe(true)
    expect(isWorkflowsEnabled({ featureFlags: [] })).toBe(false)
    expect(isWorkflowsEnabled({ featureFlags: null })).toBe(false)
  })

  it('requireWorkflowsEnabled: null when allowed, stable-coded 403 when off', async () => {
    process.env.GRID_WORKFLOWS_ENABLED = 'true'
    expect(requireWorkflowsEnabled({ featureFlags: [] })).toBeNull()

    delete process.env.GRID_WORKFLOWS_ENABLED
    const res = requireWorkflowsEnabled({ featureFlags: [] })
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: 'feature-disabled', feature: 'workflows' })
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
    expect(isFeatureEnabled({ featureFlags: [FEATURE_FLAGS.orgArchiv] }, FEATURE_FLAGS.orgArchiv)).toBe(true)
    expect(isFeatureEnabled({ featureFlags: [] }, FEATURE_FLAGS.orgArchiv)).toBe(false)
    expect(isFeatureEnabled({ featureFlags: null }, FEATURE_FLAGS.orgArchiv)).toBe(false)
  })

  it('requireFeature: null when allowed, stable-coded 403 when off', async () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    expect(requireFeature({ featureFlags: [FEATURE_FLAGS.orgArchiv] }, FEATURE_FLAGS.orgArchiv)).toBeNull()

    const res = requireFeature({ featureFlags: [] }, FEATURE_FLAGS.orgArchiv)
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: 'feature-disabled', feature: 'organization-archiv' })
  })
})
