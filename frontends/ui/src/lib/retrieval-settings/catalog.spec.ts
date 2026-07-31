import { describe, expect, it } from 'vitest'

import catalogFixture from '../../../tests/fixtures/retrieval_settings_catalog.json'

import {
  RETRIEVAL_SETTINGS,
  RETRIEVAL_SETTING_KEYS,
  getRetrievalSettingDefinition,
  retrievalSettingDefaults,
  validateRetrievalSettingValue,
} from './catalog'

describe('retrieval settings catalog', () => {
  it('contains the nine platform-tunable counts', () => {
    expect(RETRIEVAL_SETTING_KEYS).toEqual([
      'knowledge.top_k',
      'knowledge.max_chunks_per_document',
      'surface.chunk_top_k',
      'surface.max_files',
      'web.max_results',
      'web.advanced_max_results',
      'ris.max_results',
      'ris.page_size',
      'ris_catalog.max_matches',
    ])
  })

  it('pins every default to the value the tools ship with', () => {
    expect(retrievalSettingDefaults()).toEqual({
      'knowledge.top_k': 8,
      'knowledge.max_chunks_per_document': 2,
      'surface.chunk_top_k': 24,
      'surface.max_files': 8,
      'web.max_results': 5,
      'web.advanced_max_results': 2,
      'ris.max_results': 10,
      'ris.page_size': 20,
      'ris_catalog.max_matches': 5,
    })
  })

  it('matches the cross-language contract fixture byte-for-byte', () => {
    // The fixture twin lives at `frontends/ui/tests/fixtures/` and is
    // byte-identical to repo-root `tests/fixtures/retrieval_settings_catalog.json`,
    // which the Python parity test asserts against `_BOUNDS`/`_ALLOWED_VALUES`.
    expect(
      RETRIEVAL_SETTINGS.map(({ key, defaultValue, min, max, allowedValues, label, description }) => ({
        key,
        defaultValue,
        min,
        max,
        ...(allowedValues ? { allowedValues: [...allowedValues] } : {}),
        label,
        description,
      }))
    ).toEqual(catalogFixture)
  })

  it('resolves definitions by key and returns undefined for unknown keys', () => {
    expect(getRetrievalSettingDefinition('knowledge.top_k')?.max).toBe(50)
    expect(getRetrievalSettingDefinition('nope')).toBeUndefined()
  })
})

describe('validateRetrievalSettingValue', () => {
  it('accepts values at the bounds', () => {
    expect(validateRetrievalSettingValue('knowledge.top_k', 1)).toBeNull()
    expect(validateRetrievalSettingValue('knowledge.top_k', 50)).toBeNull()
    expect(validateRetrievalSettingValue('knowledge.max_chunks_per_document', 0)).toBeNull()
  })

  it('rejects values outside the bounds', () => {
    expect(validateRetrievalSettingValue('knowledge.top_k', 0)).toMatch(/zwischen 1 und 50/)
    expect(validateRetrievalSettingValue('knowledge.top_k', 51)).toMatch(/zwischen 1 und 50/)
  })

  it('rejects non-integers', () => {
    expect(validateRetrievalSettingValue('knowledge.top_k', 8.5)).toMatch(/ganze Zahlen/)
  })

  it('enforces the discrete RIS page sizes over the numeric range', () => {
    expect(validateRetrievalSettingValue('ris.page_size', 20)).toBeNull()
    expect(validateRetrievalSettingValue('ris.page_size', 30)).toMatch(/nur 10, 20, 50, 100/)
  })

  it('rejects unknown keys', () => {
    expect(validateRetrievalSettingValue('unknown.key', 1)).toMatch(/Unbekannte Einstellung/)
  })
})
