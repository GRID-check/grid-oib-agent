/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FEATURE_FLAGS,
  FLAG_KINDS,
  REGISTRY_FLAG_SLUGS,
  flagsFromWorkOS,
  isAgentAuthoredDocumentsEnabled,
  isCollaborationEnabled,
  isFeatureEnabled,
  isIfcModelsEnabled,
  isMailImportEnabled,
  isProjectKnowledgePageEnabled,
  isProjectMailInboxEnabled,
  isSkillsEnabled,
  requireFeature,
  requireSkillsEnabled,
  type KnownFeatureFlag,
} from './feature-flags'

const FLAG = FEATURE_FLAGS.modelConfiguration

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the registry', () => {
  it('contains the known flags with their WorkOS slugs', () => {
    expect(FEATURE_FLAGS.modelConfiguration).toBe('runtime-model-config')
    expect(FEATURE_FLAGS.deepResearch).toBe('deep-research')
    expect(FEATURE_FLAGS.memoryReflection).toBe('memory-reflection')
    expect(FEATURE_FLAGS.postAnswerFollowUps).toBe('post-answer-follow-ups')
  })

  it('classifies every slug, and nothing that is not one', () => {
    // `FLAG_KINDS` is a Record over the slug union, so tsc already refuses a
    // missing entry; this pins that the runtime object agrees.
    expect(Object.keys(FLAG_KINDS).sort()).toEqual([...REGISTRY_FLAG_SLUGS].sort())
  })

  it('keeps the entitlements that cost money or widen who reads what OFF where nobody signs in', () => {
    const entitlements = REGISTRY_FLAG_SLUGS.filter((slug) => FLAG_KINDS[slug] === 'entitlement').sort()
    expect(entitlements).toEqual(
      [
        'byok-llm',
        'collaboration',
        'deep-research',
        'mail-import',
        'piloti-acts',
        'piloti-wakes',
        'project-mail-inbox',
        'runtime-model-config',
        'skills',
        'task-automation',
      ].sort()
    )
  })
})

describe('where people sign in (REQUIRE_AUTH=true): WorkOS decides, fail-closed', () => {
  beforeEach(() => {
    vi.stubEnv('REQUIRE_AUTH', 'true')
  })

  it('reads flags from WorkOS', () => {
    expect(flagsFromWorkOS()).toBe(true)
  })

  it('passes only sessions carrying the flag slug', () => {
    expect(isFeatureEnabled({ featureFlags: [FLAG] }, FLAG)).toBe(true)
    expect(isFeatureEnabled({ featureFlags: ['other-flag'] }, FLAG)).toBe(false)
    expect(isFeatureEnabled({ featureFlags: [] }, FLAG)).toBe(false)
  })

  it('fails a token without the claim closed (stale session)', () => {
    expect(isFeatureEnabled({ featureFlags: null }, FLAG)).toBe(false)
  })

  it('gives a rollout no default either — absent from the claim is off', () => {
    // The default-ON env gates (`GRID_IFC_MODELS_ENABLED`,
    // `GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED`) are gone; what WorkOS says is
    // what the session gets.
    expect(isIfcModelsEnabled({ featureFlags: [] })).toBe(false)
    expect(isAgentAuthoredDocumentsEnabled({ featureFlags: [] })).toBe(false)
    expect(isIfcModelsEnabled({ featureFlags: [FEATURE_FLAGS.ifcModels] })).toBe(true)
  })

  it('ignores every retired environment fallback', () => {
    for (const name of [
      'GRID_SKILLS_ENABLED',
      'GRID_COLLABORATION_ENABLED',
      'GRID_MAIL_IMPORT_ENABLED',
      'GRID_PROJECT_KNOWLEDGE_PAGE_ENABLED',
    ]) {
      vi.stubEnv(name, 'true')
    }
    vi.stubEnv('GRID_IFC_MODELS_ENABLED', 'true')
    const none = { featureFlags: [] }
    expect(isSkillsEnabled(none)).toBe(false)
    expect(isCollaborationEnabled(none)).toBe(false)
    expect(isMailImportEnabled(none)).toBe(false)
    expect(isProjectKnowledgePageEnabled(none)).toBe(false)
    expect(isIfcModelsEnabled(none)).toBe(false)
  })

  it('requireFeature returns a stable-coded 403', async () => {
    const res = requireFeature({ featureFlags: [] }, FLAG)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: 'feature-disabled', feature: FLAG })
    expect(requireFeature({ featureFlags: [FLAG] }, FLAG)).toBeNull()
  })

  it('requireSkillsEnabled: null when allowed, stable-coded 403 when off', async () => {
    expect(requireSkillsEnabled({ featureFlags: [FEATURE_FLAGS.skills] })).toBeNull()
    const res = requireSkillsEnabled({ featureFlags: [] })
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: 'feature-disabled', feature: 'skills' })
  })
})

describe('where nobody signs in (REQUIRE_AUTH unset): rollouts on, entitlements off', () => {
  beforeEach(() => {
    vi.stubEnv('REQUIRE_AUTH', '')
  })

  it('does not read flags from WorkOS', () => {
    expect(flagsFromWorkOS()).toBe(false)
  })

  it('answers each flag by its kind, whatever the session carries', () => {
    for (const slug of REGISTRY_FLAG_SLUGS) {
      const expected = FLAG_KINDS[slug] === 'rollout'
      for (const featureFlags of [null, [], [slug]] as (KnownFeatureFlag[] | null)[]) {
        expect(isFeatureEnabled({ featureFlags }, slug), `${slug} ${JSON.stringify(featureFlags)}`).toBe(
          expected
        )
      }
    }
  })

  it('so the model surfaces and filing are on, and skills and collaboration are not', () => {
    expect(isIfcModelsEnabled({ featureFlags: null })).toBe(true)
    expect(isAgentAuthoredDocumentsEnabled({ featureFlags: null })).toBe(true)
    expect(isProjectKnowledgePageEnabled({ featureFlags: null })).toBe(true)
    expect(isSkillsEnabled({ featureFlags: null })).toBe(false)
    expect(isCollaborationEnabled({ featureFlags: null })).toBe(false)
    expect(isMailImportEnabled({ featureFlags: null })).toBe(false)
    expect(isFeatureEnabled({ featureFlags: null }, FEATURE_FLAGS.deepResearch)).toBe(false)
  })

  it('is not talked into an entitlement by a retired environment variable', () => {
    vi.stubEnv('GRID_SKILLS_ENABLED', 'true')
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    expect(isSkillsEnabled({ featureFlags: [FEATURE_FLAGS.skills] })).toBe(false)
  })
})

describe('project-mail-inbox, an entitlement', () => {
  it('registry carries the project-mail-inbox slug', () => {
    expect(FEATURE_FLAGS.projectMailInbox).toBe('project-mail-inbox')
  })

  it('is OFF where nobody signs in, whatever a session claims', () => {
    vi.stubEnv('REQUIRE_AUTH', 'false')
    expect(isProjectMailInboxEnabled({ featureFlags: [FEATURE_FLAGS.projectMailInbox] })).toBe(false)
  })

  it('follows the per-org claim where people sign in', () => {
    vi.stubEnv('REQUIRE_AUTH', 'true')
    expect(isProjectMailInboxEnabled({ featureFlags: [FEATURE_FLAGS.projectMailInbox] })).toBe(true)
    expect(isProjectMailInboxEnabled({ featureFlags: [] })).toBe(false)
    expect(isProjectMailInboxEnabled({ featureFlags: null })).toBe(false)
  })
})
