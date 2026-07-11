import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/llm-credentials/service', () => ({
  resolveActiveCredentialForBackend: vi.fn(),
}))

vi.mock('./openrouter', async (importOriginal) => {
  const original = await importOriginal<typeof import('./openrouter')>()
  return {
    ...original,
    fetchModelCatalog: vi.fn().mockResolvedValue([
      {
        id: 'vendor/capable',
        name: 'Capable',
        contextLength: 200000,
        promptPrice: 0,
        completionPrice: 0,
        inputModalities: ['text'],
        supportedParameters: ['tools'],
      },
    ]),
  }
})

import { getCatalogForOrg } from './org-catalog'
import { resolveActiveCredentialForBackend } from '@/lib/llm-credentials/service'
import { fetchModelCatalog } from './openrouter'

const fetchSpy = vi.spyOn(globalThis, 'fetch')

describe('getCatalogForOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    fetchSpy.mockReset()
  })

  it('uses the platform OpenRouter catalog when the org has no credential', async () => {
    vi.mocked(resolveActiveCredentialForBackend).mockResolvedValue(null)
    const catalog = await getCatalogForOrg('org_1')
    expect(catalog.source).toBe('openrouter')
    expect(catalog.validation).toBe('full')
    expect(catalog.models[0].id).toBe('vendor/capable')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps the full OpenRouter catalog for an openrouter BYOK credential', async () => {
    vi.mocked(resolveActiveCredentialForBackend).mockResolvedValue({
      id: 'cred-1',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-org',
      keyFingerprint: 'f',
    })
    const catalog = await getCatalogForOrg('org_1')
    expect(catalog).toMatchObject({ source: 'byok', provider: 'openrouter', validation: 'full' })
    expect(fetchModelCatalog).toHaveBeenCalled()
  })

  it('lists the provider models with the org key for non-openrouter credentials', async () => {
    vi.mocked(resolveActiveCredentialForBackend).mockResolvedValue({
      id: 'cred-2',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-org',
      keyFingerprint: 'f',
    })
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o' }, { id: 'o4-mini' }, { id: 'bad id' }] }), {
        status: 200,
      }),
    )
    const catalog = await getCatalogForOrg('org_1')
    expect(catalog).toMatchObject({ source: 'byok', provider: 'openai', validation: 'listed' })
    expect(catalog.models.map((m) => m.id)).toEqual(['gpt-4o', 'o4-mini'])
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('https://api.openai.com/v1/models')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-org')
  })

  it('throws when the provider listing fails (callers surface 503)', async () => {
    vi.mocked(resolveActiveCredentialForBackend).mockResolvedValue({
      id: 'cred-3',
      provider: 'custom',
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-org',
      keyFingerprint: 'f',
    })
    fetchSpy.mockResolvedValue(new Response('nope', { status: 401 }))
    await expect(getCatalogForOrg('org_1')).rejects.toThrow('HTTP 401')
  })
})
