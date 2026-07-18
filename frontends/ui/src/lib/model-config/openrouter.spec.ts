/**
 * DRY-RUN NOTE: OpenRouter is not reachable from CI; these fixtures replay
 * the catalog shape documented at openrouter.ai/docs (GET /api/v1/models:
 * `context_length`, `supported_parameters`, `architecture.input_modalities`,
 * string-encoded `pricing`). Live verification happens operationally; the
 * PUT route re-validates against the live catalog on every save.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getAgentGroup } from './agent-groups'
import {
  _clearCatalogCache,
  fetchModelCatalog,
  fetchZdrModelIds,
  filterCatalogToZdr,
  searchModelsForGroup,
  validateModelForGroup,
  validateOverrides,
  type OpenRouterModel,
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
  const intent = getAgentGroup('intent')!

  it('accepts a capable model for deep research', () => {
    expect(validateModelForGroup(model({}), deepResearch)).toEqual({ ok: true, reasons: [] })
  })

  it('rejects a model without tool support for tool-calling groups', () => {
    const result = validateModelForGroup(model({ supportedParameters: ['temperature'] }), deepResearch)
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toContain("required parameter 'tools'")
  })

  it('rejects a model with too little context', () => {
    const result = validateModelForGroup(model({ contextLength: 8192 }), deepResearch)
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toContain('context length')
  })

  it('rejects a model that cannot take text input', () => {
    const result = validateModelForGroup(model({ inputModalities: ['image'] }), intent)
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toContain('text input')
  })

  it('small-context model is still fine for low-context groups', () => {
    expect(validateModelForGroup(model({ contextLength: 32768 }), intent).ok).toBe(true)
  })
})

describe('reasoning-off enforcement (intent group runs reasoning_effort:none)', () => {
  const intent = getAgentGroup('intent')!
  const shallow = getAgentGroup('shallow_research')!
  const REASON = 'Modell erfordert Reasoning — für diese Aufgabe ist Reasoning deaktiviert'

  it('non-reasoning model passes for the reasoning-off intent group', () => {
    const nonReasoning = model({ id: 'vendor/plain', supportedParameters: ['tools', 'temperature'] })
    expect(validateModelForGroup(nonReasoning, intent).ok).toBe(true)
  })

  it('grok-style model (declares reasoning) fails for intent but passes for shallow_research', () => {
    const grok = model({
      id: 'x-ai/grok-4.5',
      supportedParameters: ['tools', 'temperature', 'reasoning'],
    })
    const forIntent = validateModelForGroup(grok, intent)
    expect(forIntent.ok).toBe(false)
    expect(forIntent.reasons).toContain(REASON)

    // shallow_research does not disable reasoning, so the same model is fine.
    expect(validateModelForGroup(grok, shallow).ok).toBe(true)
  })

  it('allowlisted hybrid family (deepseek/ prefix) passes for intent even with reasoning declared', () => {
    const deepseek = model({
      id: 'deepseek/deepseek-v4-flash',
      supportedParameters: ['tools', 'temperature', 'reasoning'],
    })
    expect(validateModelForGroup(deepseek, intent).ok).toBe(true)
  })

  it('include_reasoning also counts as declaring reasoning', () => {
    const m = model({ id: 'vendor/reasoner', supportedParameters: ['tools', 'include_reasoning'] })
    expect(validateModelForGroup(m, intent).ok).toBe(false)
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
    // 'no-tools' passes intent (no tool requirement, big context) but the
    // query narrows the passing set to it alone.
    expect(searchModelsForGroup(CATALOG, 'intent', 'no-tools').map((m) => m.id)).toEqual(['vendor/no-tools'])
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
      intent: 'vendor/not-in-catalog',
      shallow_research: 'vendor/no-tools',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.bogus_group).toContain('unknown agent group')
    expect(result.errors.intent).toContain('not found')
    expect(result.errors.shallow_research).toContain('tools')
  })

  it('rejects a reasoning-mandatory model for the reasoning-off intent group (save-path 422)', () => {
    const result = validateOverrides(CATALOG, { intent: 'x-ai/grok-4.5' })
    expect(result.ok).toBe(false)
    expect(result.errors.intent).toContain('Reasoning deaktiviert')
    expect(result.snapshot.intent).toBeUndefined()
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

describe('filterCatalogToZdr', () => {
  it('keeps only models whose base id is on the ZDR set (variant-insensitive)', () => {
    const zdr = new Set(['vendor/full-model', 'x-ai/grok-4.5'])
    const catalog = [
      model({ id: 'vendor/full-model' }),
      model({ id: 'x-ai/grok-4.5:free' }), // :variant still matches its base id
      model({ id: 'vendor/no-tools' }), // not on the ZDR set
    ]
    expect(filterCatalogToZdr(catalog, zdr).map((m) => m.id)).toEqual(['vendor/full-model', 'x-ai/grok-4.5:free'])
  })
})

describe('fetchZdrModelIds', () => {
  afterEach(async () => {
    await _clearCatalogCache()
    vi.unstubAllGlobals()
  })

  it('collects base model ids from the ZDR endpoint listing, whatever the shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { name: 'DeepSeek | ZDR', model: { slug: 'deepseek/deepseek-v4-flash:nitro' } },
          { id: 'anthropic/claude-sonnet-4.5', provider_name: 'anthropic' },
          { name: 'not-a-model', model_variant_slug: 'x-ai/grok-4.5' },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const ids = await fetchZdrModelIds()
    expect([...ids].sort()).toEqual([
      'anthropic/claude-sonnet-4.5',
      'deepseek/deepseek-v4-flash',
      'x-ai/grok-4.5',
    ])
    // cached
    await fetchZdrModelIds()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails CLOSED — throws on upstream error (never an empty allowlist)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(fetchZdrModelIds()).rejects.toThrow('HTTP 503')
  })

  it('throws when the listing yields no model ids (never silently allow-all/none)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }))
    await expect(fetchZdrModelIds()).rejects.toThrow('no model ids')
  })
})
