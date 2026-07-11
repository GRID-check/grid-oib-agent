import { afterEach, describe, expect, it } from 'vitest'

import { assertSafeBaseUrl, isKnownProvider, resolveBaseUrl } from './providers'

describe('llm-credentials providers', () => {
  afterEach(() => {
    delete process.env.GRID_BYOK_ALLOW_PRIVATE_BASE_URLS
  })

  it('knows the preset providers', () => {
    expect(isKnownProvider('openrouter')).toBe(true)
    expect(isKnownProvider('azure-openai')).toBe(true)
    expect(isKnownProvider('anthropic')).toBe(false)
  })

  it('resolves preset base URLs and rejects overriding them', () => {
    expect(resolveBaseUrl('openrouter', null)).toBe('https://openrouter.ai/api/v1')
    expect(resolveBaseUrl('openai', undefined)).toBe('https://api.openai.com/v1')
    expect(() => resolveBaseUrl('openrouter', 'https://evil.example/v1')).toThrow(/fixed endpoint/)
  })

  it('requires a base URL for azure/custom and strips trailing slashes', () => {
    expect(() => resolveBaseUrl('custom', null)).toThrow(/requires a base URL/)
    expect(resolveBaseUrl('custom', 'https://gw.example.com/v1/')).toBe('https://gw.example.com/v1')
  })

  it('rejects non-HTTPS, credentialed, and private-network base URLs', () => {
    expect(() => assertSafeBaseUrl('http://gw.example.com/v1')).toThrow(/HTTPS/)
    expect(() => assertSafeBaseUrl('https://user:pw@gw.example.com/v1')).toThrow(/credentials/)
    expect(() => assertSafeBaseUrl('https://localhost/v1')).toThrow(/private or local/)
    expect(() => assertSafeBaseUrl('https://10.0.0.5/v1')).toThrow(/private or local/)
    expect(() => assertSafeBaseUrl('https://172.16.0.1/v1')).toThrow(/private or local/)
    expect(() => assertSafeBaseUrl('https://192.168.1.1/v1')).toThrow(/private or local/)
    expect(() => assertSafeBaseUrl('https://llm.corp.internal/v1')).toThrow(/private or local/)
    expect(() => assertSafeBaseUrl('not a url')).toThrow(/not a valid URL/)
  })

  it('accepts public HTTPS endpoints', () => {
    expect(() => assertSafeBaseUrl('https://openrouter.ai/api/v1')).not.toThrow()
    expect(() => assertSafeBaseUrl('https://my-resource.openai.azure.com/openai/v1')).not.toThrow()
  })

  it('honours the private-network escape hatch', () => {
    process.env.GRID_BYOK_ALLOW_PRIVATE_BASE_URLS = 'true'
    expect(() => assertSafeBaseUrl('https://litellm.corp.internal/v1')).not.toThrow()
  })
})
