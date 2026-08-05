import { describe, expect, it } from 'vitest'

import catalogFixture from '../../../tests/fixtures/reasoning_efforts_catalog.json'

import {
  REASONING_EFFORTS,
  isReasoningEffort,
  validateReasoningEffort,
} from './catalog'

describe('reasoning effort catalog', () => {
  it("exposes OpenRouter's unified levels, cheapest first", () => {
    // Order is load-bearing: the admin form renders the levels in it, so a
    // reordering would silently present "more expensive" as "less".
    expect(REASONING_EFFORTS).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('has a translated label for every level in both dictionaries', async () => {
    // Labels live in i18n, not here: hardcoding them in the catalog is how the
    // card ended up rendering German level names beside English group names.
    const [de, en] = await Promise.all([
      import('@/i18n/dictionaries/de/platform'),
      import('@/i18n/dictionaries/en/platform'),
    ])
    for (const dict of [de.platform, en.platform]) {
      const levels = dict.models.levels as Record<string, { label: string; hint: string }>
      expect(Object.keys(levels).sort()).toEqual([...REASONING_EFFORTS].sort())
      for (const effort of REASONING_EFFORTS) {
        expect(levels[effort].label).toBeTruthy()
        expect(levels[effort].hint).toBeTruthy()
      }
    }
  })

  it('rejects provider-native tier names', () => {
    // DeepSeek's "max" is the concrete trap the config file warns about:
    // OpenRouter rejects/ignores provider-native names, so only the unified
    // vocabulary may ever be stored.
    expect(isReasoningEffort('max')).toBe(false)
    expect(validateReasoningEffort('max')).toMatch(/not a reasoning effort/)
    expect(validateReasoningEffort('MEDIUM')).toMatch(/not a reasoning effort/)
    expect(validateReasoningEffort(3)).toMatch(/not a reasoning effort/)
    expect(validateReasoningEffort(null)).toMatch(/not a reasoning effort/)
  })

  it('accepts every catalog level', () => {
    for (const effort of REASONING_EFFORTS) {
      expect(validateReasoningEffort(effort)).toBeNull()
    }
  })

  it('matches the cross-language contract fixture', () => {
    // The fixture twin lives at `frontends/ui/tests/fixtures/` and is
    // byte-identical to repo-root `tests/fixtures/reasoning_efforts_catalog.json`,
    // which the Python parity test asserts against `_EFFORTS`. A level added
    // here without the backend counterpart fails there.
    expect([...REASONING_EFFORTS]).toEqual(catalogFixture)
  })
})
