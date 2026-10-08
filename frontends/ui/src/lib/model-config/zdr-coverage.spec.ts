/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const getActiveModelOverrides = vi.fn()
vi.mock('./service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./service')>()),
  getActiveModelOverrides: (id: string) => getActiveModelOverrides(id),
}))
const getGroupDefaultSources = vi.fn()
vi.mock('./backend-defaults', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backend-defaults')>()),
  getGroupDefaultSources: () => getGroupDefaultSources(),
}))
const fetchZdrEndpoints = vi.fn()
vi.mock('./openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openrouter')>()),
  fetchZdrEndpoints: () => fetchZdrEndpoints(),
}))

import { AGENT_GROUP_IDS } from './agent-groups'
import type { GroupDefaultSource } from './backend-defaults'
import type { ZdrEndpoint, ZdrIndex } from './openrouter'
import { findZdrBlockedGroups, getZdrCoverage, resolveEffectiveGroupModels } from './zdr-coverage'

const zdr = (...endpoints: Array<Partial<ZdrEndpoint> & { modelId: string }>): ZdrIndex => {
  const map = new Map<string, ZdrEndpoint[]>()
  for (const endpoint of endpoints) {
    const full = { supportedParameters: ['tools'], contextLength: 1048576, ...endpoint }
    map.set(full.modelId, [...(map.get(full.modelId) ?? []), full])
  }
  return map
}

/** Every group inheriting from `source`, with overrides per group. */
const inherited = (
  fill: GroupDefaultSource,
  overrides: Record<string, GroupDefaultSource> = {}
): Record<string, GroupDefaultSource> => ({
  ...Object.fromEntries(AGENT_GROUP_IDS.map((id) => [id, fill])),
  ...overrides,
})
const NONE: GroupDefaultSource = { model: null, source: null }

describe('resolveEffectiveGroupModels', () => {
  it('layers the org override over the inherited default (platform, else workflow), per group', () => {
    const models = resolveEffectiveGroupModels(
      { deep_research: 'org/own' },
      inherited(NONE, {
        deep_research: { model: 'platform/pinned', source: 'platform' },
        clarifier: { model: 'platform/pinned', source: 'platform' },
        follow_ups: { model: 'yaml/a, yaml/b', source: 'workflow' },
      })
    )
    const byGroup = Object.fromEntries(models.map((m) => [m.group, m]))
    expect(byGroup.deep_research).toEqual({ group: 'deep_research', modelIds: ['org/own'], source: 'org' })
    expect(byGroup.clarifier).toEqual({ group: 'clarifier', modelIds: ['platform/pinned'], source: 'platform' })
    // A multi-LLM workflow group is checked model by model.
    expect(byGroup.follow_ups).toEqual({ group: 'follow_ups', modelIds: ['yaml/a', 'yaml/b'], source: 'workflow' })
    expect(byGroup.memory_reflection).toEqual({ group: 'memory_reflection', modelIds: [], source: null })
  })

  it('ignores an org override for a group that no longer exists', () => {
    const models = resolveEffectiveGroupModels({ intent: 'org/own' }, inherited(NONE))
    expect(models.map((m) => m.group)).not.toContain('intent')
  })
})

describe('findZdrBlockedGroups', () => {
  it('reports inherited defaults too, with where they come from and why', () => {
    const blocked = findZdrBlockedGroups(
      [
        { group: 'deep_research', modelIds: ['platform/no-zdr'], source: 'platform' },
        { group: 'clarifier', modelIds: ['org/tools-off'], source: 'org' },
        { group: 'shallow_research', modelIds: ['org/fine'], source: 'org' },
        { group: 'memory_reflection', modelIds: [], source: null },
      ],
      zdr({ modelId: 'org/fine' }, { modelId: 'org/tools-off', supportedParameters: ['max_tokens'] })
    )
    expect(blocked).toEqual([
      { group: 'deep_research', modelId: 'platform/no-zdr', source: 'platform', reason: 'not_zdr' },
      { group: 'clarifier', modelId: 'org/tools-off', source: 'org', reason: 'zdr_endpoint_lacks_capability' },
    ])
  })

  it('does not credit a :free variant with its base model’s ZDR endpoint', () => {
    const blocked = findZdrBlockedGroups(
      [{ group: 'deep_research', modelIds: ['vendor/model:free'], source: 'org' }],
      zdr({ modelId: 'vendor/model' })
    )
    expect(blocked.map((b) => b.reason)).toEqual(['not_zdr'])
  })
})

describe('getZdrCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveModelOverrides.mockResolvedValue(null)
    getGroupDefaultSources.mockResolvedValue(
      inherited(
        { model: 'openai/gpt-6-luna', source: 'workflow' },
        { deep_research: { model: 'platform/no-zdr', source: 'platform' } }
      )
    )
    fetchZdrEndpoints.mockResolvedValue(zdr({ modelId: 'openai/gpt-6-luna' }))
  })

  it('flags the inherited platform default of an org that chose nothing', async () => {
    const coverage = await getZdrCoverage('org_1')
    expect(coverage.status).toBe('checked')
    expect(coverage.blockedGroups).toEqual([
      { group: 'deep_research', modelId: 'platform/no-zdr', source: 'platform', reason: 'not_zdr' },
    ])
    expect(coverage.unresolvedGroups).toEqual([])
  })

  it('an org override on a ZDR model clears the group', async () => {
    getActiveModelOverrides.mockResolvedValue({ deep_research: 'openai/gpt-6-luna' })
    expect((await getZdrCoverage('org_1')).blockedGroups).toEqual([])
  })

  it('says "unknown", never "all clear", when the ZDR list cannot be read', async () => {
    fetchZdrEndpoints.mockRejectedValue(new Error('HTTP 503'))
    const coverage = await getZdrCoverage('org_1')
    expect(coverage).toEqual({ status: 'unknown', blockedGroups: [], unresolvedGroups: [] })
  })

  it('names groups whose model could not be resolved', async () => {
    getGroupDefaultSources.mockResolvedValue(
      inherited(NONE, { deep_research: { model: 'openai/gpt-6-luna', source: 'platform' } })
    )
    const coverage = await getZdrCoverage('org_1')
    expect(coverage.unresolvedGroups).toEqual(AGENT_GROUP_IDS.filter((id) => id !== 'deep_research'))
  })
})
