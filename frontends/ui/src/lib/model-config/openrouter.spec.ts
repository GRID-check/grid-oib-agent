/**
 * @vitest-environment node
 */
/**
 * DRY-RUN NOTE: OpenRouter is not reachable from CI; these fixtures replay
 * the catalog shape documented at openrouter.ai/docs (GET /api/v1/models:
 * `context_length`, `supported_parameters`, `architecture.input_modalities`,
 * string-encoded `pricing`). Live verification happens operationally; the
 * PUT route re-validates against the live catalog on every save.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setCacheStore, type CacheStore } from '@/lib/cache'
import { getAgentGroup } from './agent-groups'
import {
  _clearCatalogCache,
  fetchModelCatalog,
  fetchZdrEndpoints,
  hasZdrEndpoint,
  searchModelsForGroup,
  validateModelForGroup,
  validateOverrides,
  ZdrListUnavailableError,
  type OpenRouterModel,
  type ZdrEndpoint,
  type ZdrIndex,
} from './openrouter'

const model = (overrides: Partial<OpenRouterModel>): OpenRouterModel => ({
  id: 'vendor/full-model',
  name: 'Vendor: Full Model',
  contextLength: 200000,
  promptPrice: 0.000003,
  completionPrice: 0.000015,
  inputModalities: ['text', 'image'],
  supportedParameters: ['tools', 'tool_choice', 'temperature', 'structured_outputs'],
  ...overrides,
})

const CATALOG: OpenRouterModel[] = [
  model({}),
  model({ id: 'vendor/no-tools', supportedParameters: ['temperature'] }),
  model({ id: 'vendor/small-context', contextLength: 8192 }),
  model({ id: 'vendor/vision-only', inputModalities: ['image'] }),
  model({ id: 'x-ai/grok-4.5', supportedParameters: ['tools', 'temperature', 'reasoning'] }),
]

describe('validateModelForGroup', () => {
  const deepResearch = getAgentGroup('deep_research')!
  const followUps = getAgentGroup('follow_ups')!

  it('accepts a capable model for deep research', () => {
    expect(validateModelForGroup(model({}), deepResearch)).toEqual({ ok: true, reasons: [] })
  })

  it('rejects a model without tool support for tool-calling groups', () => {
    const result = validateModelForGroup(model({ supportedParameters: ['temperature'] }), deepResearch)
    expect(result.ok).toBe(false)
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'missing_parameter', params: { parameter: 'tools' } }),
    )
  })

  it('rejects a model with too little context', () => {
    const result = validateModelForGroup(model({ contextLength: 8192 }), deepResearch)
    expect(result.ok).toBe(false)
    expect(result.reasons.map((r) => r.code)).toEqual(['context_too_small'])
    expect(result.reasons[0].params).toEqual({ actual: 8192, required: 131072 })
  })

  it('rejects a model that cannot take text input', () => {
    const result = validateModelForGroup(model({ inputModalities: ['image'] }), followUps)
    expect(result.ok).toBe(false)
    expect(result.reasons.map((r) => r.code)).toContain('no_text_input')
  })

  it('small-context model is still fine for low-context groups', () => {
    expect(validateModelForGroup(model({ contextLength: 32768 }), followUps).ok).toBe(true)
  })

  it('ingest_vlm accepts a vision model and rejects a text-only one', () => {
    const ingestVlm = getAgentGroup('ingest_vlm')!
    // A vision model (input_modalities includes image) passes.
    expect(validateModelForGroup(model({ inputModalities: ['text', 'image'] }), ingestVlm).ok).toBe(true)
    // A text-only model is rejected — it could not see the page/drawing.
    const textOnly = validateModelForGroup(model({ inputModalities: ['text'] }), ingestVlm)
    expect(textOnly.ok).toBe(false)
    expect(textOnly.reasons.map((r) => r.code)).toEqual(['no_image_input'])
  })

  it('vision requirement self-skips when the catalog has no modality metadata (BYOK)', () => {
    const ingestVlm = getAgentGroup('ingest_vlm')!
    expect(validateModelForGroup(model({ inputModalities: [] }), ingestVlm).ok).toBe(true)
  })
})

describe('reasoning-off enforcement (follow_ups group runs reasoning_effort:none)', () => {
  const followUps = getAgentGroup('follow_ups')!
  const shallow = getAgentGroup('shallow_research')!

  it('non-reasoning model passes for the reasoning-off follow_ups group', () => {
    const nonReasoning = model({ id: 'vendor/plain', supportedParameters: ['tools', 'temperature'] })
    expect(validateModelForGroup(nonReasoning, followUps).ok).toBe(true)
  })

  it('reasoning-mandatory family (denylisted, e.g. x-ai/grok-4) fails for follow_ups but passes for shallow_research', () => {
    const grok = model({
      id: 'x-ai/grok-4.5',
      supportedParameters: ['tools', 'temperature', 'reasoning'],
    })
    const forFollowUps = validateModelForGroup(grok, followUps)
    expect(forFollowUps.ok).toBe(false)
    // A code, not prose: this used to be hard-coded German for every reader.
    expect(forFollowUps.reasons.map((r) => r.code)).toEqual(['reasoning_mandatory'])

    // shallow_research does not disable reasoning, so the same model is fine.
    expect(validateModelForGroup(grok, shallow).ok).toBe(true)
  })

  it('OpenAI o-series (denylisted prefix) fails for the reasoning-off follow_ups group', () => {
    const o3 = model({ id: 'openai/o3-mini', supportedParameters: ['tools', 'reasoning'] })
    expect(validateModelForGroup(o3, followUps).ok).toBe(false)
  })

  it('hybrid reasoning model (declares reasoning, not denylisted) now PASSES for follow_ups', () => {
    // The common modern case: the model advertises reasoning but accepts
    // reasoning-off. We fail open, so it is selectable for the follow_ups group.
    const hybrid = model({
      id: 'anthropic/claude-sonnet-4.5',
      supportedParameters: ['tools', 'temperature', 'reasoning'],
    })
    expect(validateModelForGroup(hybrid, followUps).ok).toBe(true)
  })

  it('deepseek chat (hybrid) passes, deepseek-r1 (reasoning-only, denylisted) fails', () => {
    const chat = model({
      id: 'deepseek/deepseek-v4-flash',
      supportedParameters: ['tools', 'temperature', 'reasoning'],
    })
    expect(validateModelForGroup(chat, followUps).ok).toBe(true)

    const r1 = model({ id: 'deepseek/deepseek-r1', supportedParameters: ['tools', 'reasoning'] })
    expect(validateModelForGroup(r1, followUps).ok).toBe(false)
  })

  it('a model that merely declares include_reasoning still passes (hybrid, not denylisted)', () => {
    const m = model({ id: 'vendor/reasoner', supportedParameters: ['tools', 'include_reasoning'] })
    expect(validateModelForGroup(m, followUps).ok).toBe(true)
  })
})

describe('searchModelsForGroup', () => {
  it('filters to appropriate models only', () => {
    const results = searchModelsForGroup(CATALOG, 'deep_research', '')
    // vendor/full-model and x-ai/grok-4.5 both satisfy deep_research (tools +
    // 200k context); deep_research does not disable reasoning, so grok's
    // declared reasoning is fine here (same as the shallow_research case above).
    expect(results.map((m) => m.id)).toEqual(['vendor/full-model', 'x-ai/grok-4.5'])
  })

  it('applies the text query', () => {
    // 'no-tools' passes follow_ups (no tool requirement, big context) but the
    // query narrows the passing set to it alone.
    expect(searchModelsForGroup(CATALOG, 'follow_ups', 'no-tools').map((m) => m.id)).toEqual(['vendor/no-tools'])
  })

  it('returns nothing for an unknown group', () => {
    expect(searchModelsForGroup(CATALOG, 'nope', '')).toEqual([])
  })
})

describe('validateOverrides', () => {
  it('accepts a valid overrides object and snapshots catalog metadata', () => {
    const result = validateOverrides(CATALOG, { deep_research: 'vendor/full-model' })
    expect(result.ok).toBe(true)
    expect(result.snapshot.deep_research.id).toBe('vendor/full-model')
  })

  it('rejects unknown groups, unknown models, and capability mismatches', () => {
    const result = validateOverrides(CATALOG, {
      bogus_group: 'vendor/full-model',
      follow_ups: 'vendor/not-in-catalog',
      shallow_research: 'vendor/no-tools',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.bogus_group.map((r) => r.code)).toEqual(['unknown_group'])
    expect(result.errors.follow_ups).toEqual([
      expect.objectContaining({ code: 'not_in_catalog', params: { model: 'vendor/not-in-catalog' } }),
    ])
    expect(result.errors.shallow_research.map((r) => r.code)).toEqual(['missing_parameter'])
  })

  it('rejects a reasoning-mandatory model for the reasoning-off follow_ups group (save-path 422)', () => {
    const result = validateOverrides(CATALOG, { follow_ups: 'x-ai/grok-4.5' })
    expect(result.ok).toBe(false)
    expect(result.errors.follow_ups.map((r) => r.code)).toEqual(['reasoning_mandatory'])
    expect(result.snapshot.follow_ups).toBeUndefined()
  })

  it('accepts the same reasoning model for a group that keeps reasoning on', () => {
    const result = validateOverrides(CATALOG, { shallow_research: 'x-ai/grok-4.5' })
    expect(result.ok).toBe(true)
    expect(result.snapshot.shallow_research.id).toBe('x-ai/grok-4.5')
  })
})

describe('fetchModelCatalog', () => {
  afterEach(async () => {
    await _clearCatalogCache()
    vi.unstubAllGlobals()
  })

  it('parses the documented OpenRouter response shape and caches it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'deepseek/deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            context_length: 163840,
            pricing: { prompt: '0.00000027', completion: '0.0000011' },
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            supported_parameters: ['tools', 'temperature', 'structured_outputs'],
          },
          { id: 'not a model id' },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await fetchModelCatalog()
    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      id: 'deepseek/deepseek-v4-flash',
      contextLength: 163840,
      promptPrice: 0.00000027,
      supportedParameters: ['tools', 'temperature', 'structured_outputs'],
    })

    await fetchModelCatalog()
    expect(fetchMock).toHaveBeenCalledTimes(1) // cached
  })

  it('throws on upstream failure (callers translate to 503)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }))
    await expect(fetchModelCatalog()).rejects.toThrow('HTTP 502')
  })
})

/**
 * One entry of `GET /api/v1/endpoints/zdr` in its LIVE shape (captured
 * 2026-09-30; `name`, `tag` and `provider_name` are exactly what the listing
 * carries). `tag` values like `azure/eu` and names like
 * `Reka | deepseek/deepseek-v4-pro-20260423` look like model ids and are not:
 * the old recursive scan collected them as ZDR models.
 */
const zdrEntry = (
  modelId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: `Azure | ${modelId}-20260423`,
  model_id: modelId,
  model_name: modelId,
  context_length: 1048576,
  pricing: { prompt: '0.0000013', completion: '0.0000026', discount: 0 },
  provider_name: 'Azure',
  tag: 'azure/eu',
  quantization: 'unknown',
  max_completion_tokens: 131072,
  max_prompt_tokens: null,
  supported_parameters: ['tools', 'tool_choice', 'response_format', 'structured_outputs', 'max_tokens'],
  status: 0,
  uptime_last_30m: 99.9,
  ...overrides,
})

const index = (...endpoints: Array<Partial<ZdrEndpoint> & { modelId: string }>): ZdrIndex => {
  const map = new Map<string, ZdrEndpoint[]>()
  for (const endpoint of endpoints) {
    const full: ZdrEndpoint = { supportedParameters: ['tools'], contextLength: 1048576, ...endpoint }
    map.set(full.modelId, [...(map.get(full.modelId) ?? []), full])
  }
  return map
}

describe('ZDR matching is exact', () => {
  const deepResearch = getAgentGroup('deep_research')!
  const zdr = index({ modelId: 'vendor/full-model' }, { modelId: 'qwen/qwen3.8-27b:free' })

  it('matches the exact id the listing names', () => {
    expect(hasZdrEndpoint('vendor/full-model', zdr)).toBe(true)
    expect(hasZdrEndpoint('qwen/qwen3.8-27b:free', zdr)).toBe(true)
  })

  it('does NOT let a :free / :extended / :thinking variant ride on its base model', () => {
    // Different offerings with their own endpoints. The old matcher stripped
    // the suffix, so `foo/bar:free` counted as ZDR when only the paid one was.
    for (const variant of ['free', 'extended', 'thinking', 'online', 'beta']) {
      expect(hasZdrEndpoint(`vendor/full-model:${variant}`, zdr)).toBe(false)
    }
  })

  it('does NOT let a base model ride on a listed variant', () => {
    expect(hasZdrEndpoint('qwen/qwen3.8-27b', zdr)).toBe(false)
  })

  it('lets the routing-only :nitro and :floor shortcuts share the base model’s endpoints', () => {
    expect(hasZdrEndpoint('vendor/full-model:nitro', zdr)).toBe(true)
    expect(hasZdrEndpoint('vendor/full-model:floor', zdr)).toBe(true)
  })

  it('requires an endpoint that serves the group, not just any endpoint', () => {
    const noTools = index({ modelId: 'vendor/full-model', supportedParameters: ['max_tokens'] })
    expect(hasZdrEndpoint('vendor/full-model', noTools)).toBe(true)
    expect(hasZdrEndpoint('vendor/full-model', noTools, deepResearch)).toBe(false)

    // One tool-capable ZDR endpoint among several is enough.
    const mixed = index(
      { modelId: 'vendor/full-model', supportedParameters: ['max_tokens'] },
      { modelId: 'vendor/full-model', supportedParameters: ['tools'] },
    )
    expect(hasZdrEndpoint('vendor/full-model', mixed, deepResearch)).toBe(true)
  })

  it('requires the ZDR endpoint itself to carry the group’s minimum context', () => {
    const shortEndpoint = index({ modelId: 'vendor/full-model', contextLength: 32768 })
    expect(hasZdrEndpoint('vendor/full-model', shortEndpoint, deepResearch)).toBe(false)
  })
})

describe('validation under zero data retention', () => {
  const deepResearch = getAgentGroup('deep_research')!

  it('names a catalog model without a ZDR endpoint as not_zdr, not as missing from the catalog', () => {
    const zdr = index({ modelId: 'vendor/other' })
    const result = validateOverrides(CATALOG, { deep_research: 'vendor/full-model' }, true, zdr)
    expect(result.ok).toBe(false)
    expect(result.errors.deep_research).toEqual([
      expect.objectContaining({ code: 'not_zdr', params: { model: 'vendor/full-model' } }),
    ])
  })

  it('names a model whose ZDR endpoints cannot serve the group as zdr_endpoint_lacks_capability', () => {
    const zdr = index({ modelId: 'vendor/full-model', supportedParameters: ['max_tokens'] })
    const result = validateModelForGroup(model({}), deepResearch, true, zdr)
    expect(result.reasons.map((r) => r.code)).toEqual(['zdr_endpoint_lacks_capability'])
  })

  it('accepts a model with a ZDR endpoint that serves the group', () => {
    const zdr = index({ modelId: 'vendor/full-model' })
    expect(validateOverrides(CATALOG, { deep_research: 'vendor/full-model' }, true, zdr).ok).toBe(true)
  })

  it('narrows the picker to models with a serving ZDR endpoint', () => {
    const zdr = index({ modelId: 'x-ai/grok-4.5' })
    expect(searchModelsForGroup(CATALOG, 'deep_research', '', 30, true, zdr).map((m) => m.id)).toEqual([
      'x-ai/grok-4.5',
    ])
  })
})

/** An in-memory `CacheStore` whose entries a test can seed or inspect. */
const memoryCacheStore = (): { store: CacheStore; entries: Map<string, string> } => {
  const entries = new Map<string, string>()
  return {
    entries,
    store: {
      get: async (key) => entries.get(key) ?? null,
      set: async (key, value) => {
        entries.set(key, value)
      },
      delete: async (key) => {
        entries.delete(key)
      },
      deletePrefix: async (prefix) => {
        for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key)
      },
    },
  }
}

describe('fetchZdrEndpoints', () => {
  // Every test in here drives the cache directly, so each starts on its own
  // store — a swap left behind by one test must not leak into the next.
  beforeEach(() => {
    setCacheStore(memoryCacheStore().store)
  })

  afterEach(async () => {
    await _clearCatalogCache()
    vi.unstubAllGlobals()
  })

  const listing = (...entries: unknown[]) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: entries }) })

  it('indexes the live listing by model_id only — never by tag or name', async () => {
    const fetchMock = listing(
      zdrEntry('deepseek/deepseek-v4-pro', { name: 'Reka | deepseek/deepseek-v4-pro-20260423', tag: 'reka' }),
      zdrEntry('xiaomi/mimo-v2.6-flash', { tag: 'novita/fp8', provider_name: 'Novita' }),
      zdrEntry('qwen/qwen3.8-27b:free', { tag: 'modelrun' }),
      zdrEntry('deepseek/deepseek-v4-pro', { tag: 'azure/eu' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const zdr = await fetchZdrEndpoints()
    expect([...zdr.keys()].sort()).toEqual([
      'deepseek/deepseek-v4-pro',
      'qwen/qwen3.8-27b:free',
      'xiaomi/mimo-v2.6-flash',
    ])
    // `tag` values (`azure/eu`, `novita/fp8`) and the dated `name` slug are not models.
    expect(zdr.has('azure/eu')).toBe(false)
    expect(zdr.has('novita/fp8')).toBe(false)
    expect(zdr.has('deepseek/deepseek-v4-pro-20260423')).toBe(false)
    expect(zdr.get('xiaomi/mimo-v2.6-flash')?.[0]).toEqual({
      modelId: 'xiaomi/mimo-v2.6-flash',
      supportedParameters: ['tools', 'tool_choice', 'response_format', 'structured_outputs', 'max_tokens'],
      contextLength: 1048576,
    })
    // cached
    await fetchZdrEndpoints()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  /**
   * Regression (issue #242): the cache round-trips through JSON, so caching a
   * `Set`/`Map` itself returned a prototype-less `{}` on every HIT. The index
   * must be rebuilt on the way OUT of the cache.
   */
  it('returns a real index on a cache HIT, not the JSON-flattened shape', async () => {
    const fetchMock = listing(zdrEntry('anthropic/claude-sonnet-4.5'), zdrEntry('vendor/full-model'))
    vi.stubGlobal('fetch', fetchMock)

    await fetchZdrEndpoints() // miss — populates the cache
    const cached = await fetchZdrEndpoints()
    expect(fetchMock).toHaveBeenCalledTimes(1) // ...so this one is a genuine HIT

    expect(cached).toBeInstanceOf(Map)
    expect(hasZdrEndpoint('anthropic/claude-sonnet-4.5', cached)).toBe(true)
    expect(hasZdrEndpoint('vendor/no-tools', cached)).toBe(false)
    expect(
      searchModelsForGroup([model({}), model({ id: 'vendor/no-tools' })], 'follow_ups', '', 30, true, cached).map(
        (m) => m.id,
      ),
    ).toEqual(['vendor/full-model'])
  })

  it('fails CLOSED when the cached payload is an older shape', async () => {
    // What a pre-:v3 replica could leave under a reused key: bare ids, or `{}`.
    for (const payload of ['{}', JSON.stringify(['anthropic/claude-sonnet-4.5'])]) {
      const { store, entries } = memoryCacheStore()
      setCacheStore(store)
      entries.set('openrouter:zdr-endpoints:v3', payload)
      vi.stubGlobal('fetch', vi.fn())
      await expect(fetchZdrEndpoints()).rejects.toThrow('unusable')
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it('fails CLOSED when one cached element is not an endpoint (the array shape is not enough)', async () => {
    const { store, entries } = memoryCacheStore()
    setCacheStore(store)
    entries.set(
      'openrouter:zdr-endpoints:v3',
      JSON.stringify([null, { modelId: 'anthropic/claude-sonnet-4.5', supportedParameters: [], contextLength: 0 }]),
    )
    vi.stubGlobal('fetch', vi.fn())

    await expect(fetchZdrEndpoints()).rejects.toThrow(ZdrListUnavailableError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('re-reads upstream when the cached payload is not decodable', async () => {
    const { store, entries } = memoryCacheStore()
    setCacheStore(store)
    entries.set('openrouter:zdr-endpoints:v3', '{')
    const fetchMock = listing(zdrEntry('anthropic/claude-sonnet-4.5'))
    vi.stubGlobal('fetch', fetchMock)

    const zdr = await fetchZdrEndpoints()
    expect([...zdr.keys()]).toEqual(['anthropic/claude-sonnet-4.5'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails CLOSED — throws ZdrListUnavailableError on upstream error (never an empty allowlist)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(fetchZdrEndpoints()).rejects.toThrow(ZdrListUnavailableError)
    await expect(fetchZdrEndpoints()).rejects.toThrow('HTTP 503')
  })

  it('throws when the listing yields no model ids (never silently allow-all/none)', async () => {
    vi.stubGlobal('fetch', listing({ tag: 'azure/eu', name: 'Azure | vendor/model' }))
    await expect(fetchZdrEndpoints()).rejects.toThrow('no model ids')
  })
})
