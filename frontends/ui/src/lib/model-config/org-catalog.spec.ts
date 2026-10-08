import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/llm-credentials/service', () => ({
  resolveActiveCredentialForBackend: vi.fn(),
  getActiveCredentialProvider: vi.fn(),
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
    fetchZdrEndpoints: vi.fn(),
  }
})

import { getCatalogForOrg, isZdrApplicableForCredential, isZdrApplicableForOrg } from './org-catalog'
import { getActiveCredentialProvider, resolveActiveCredentialForBackend } from '@/lib/llm-credentials/service'
import { fetchModelCatalog, fetchZdrEndpoints, type ZdrEndpoint } from './openrouter'

const zdrIndex = (...ids: string[]): Map<string, ZdrEndpoint[]> =>
  new Map(ids.map((modelId) => [modelId, [{ modelId, supportedParameters: ['tools'], contextLength: 200000 }]]))

const fetchSpy = vi.spyOn(globalThis, 'fetch')

/**
 * The URL and Authorization header of the first `fetch`, under either calling
 * convention.
 *
 * The code under test calls `fetch(url, init)`, but MSW's interceptor — started
 * by the shared vitest setup — sits OUTSIDE this spy and normalises its
 * arguments into a single `Request` before passing them through. Asserting on
 * the raw first argument therefore read `[object Request]` and the init was
 * `undefined`. Reading the request either way keeps the assertion about what it
 * is actually about (which endpoint, with whose key) instead of about how many
 * arguments an interceptor happened to forward.
 */
function firstFetchCall(): { url: string; authorization: string | null } {
  const [first, init] = fetchSpy.mock.calls[0] as [RequestInfo | URL, RequestInit | undefined]
  if (first instanceof Request) {
    return { url: first.url, authorization: first.headers.get('Authorization') }
  }
  const headers = new Headers(init?.headers)
  return { url: String(first), authorization: headers.get('Authorization') }
}

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
    const { url, authorization } = firstFetchCall()
    expect(url).toBe('https://api.openai.com/v1/models')
    expect(authorization).toBe('Bearer sk-org')
  })

  it('carries the ZDR index (and the WHOLE catalog) when zdrOnly is requested', async () => {
    vi.mocked(resolveActiveCredentialForBackend).mockResolvedValue(null)
    const zdr = zdrIndex('vendor/capable')
    vi.mocked(fetchZdrEndpoints).mockResolvedValue(zdr)
    const catalog = await getCatalogForOrg('org_1', { zdrOnly: true })
    expect(catalog).toMatchObject({ zdrOnly: true, zdrApplicable: true })
    expect(catalog.zdr).toBe(zdr)
    // Unfiltered on purpose: validation must be able to say `not_zdr` rather
    // than "not in the catalog"; the picker filters with `zdr`.
    expect(catalog.models.map((m) => m.id)).toEqual(['vendor/capable'])
  })

  it('does not fetch the ZDR list when ZDR is not requested', async () => {
    vi.mocked(resolveActiveCredentialForBackend).mockResolvedValue(null)
    const catalog = await getCatalogForOrg('org_1')
    expect(catalog).toMatchObject({ zdrOnly: false, zdrApplicable: true, zdr: null })
    expect(fetchZdrEndpoints).not.toHaveBeenCalled()
  })

  it('propagates a ZDR-list outage (fail-closed, callers surface 503)', async () => {
    vi.mocked(resolveActiveCredentialForBackend).mockResolvedValue(null)
    vi.mocked(fetchZdrEndpoints).mockRejectedValue(new Error('ZDR listing HTTP 503'))
    await expect(getCatalogForOrg('org_1', { zdrOnly: true })).rejects.toThrow('503')
  })

  it('does not apply ZDR to a provider-native BYOK listing (reports zdrOnly:false, zdrApplicable:false)', async () => {
    vi.mocked(resolveActiveCredentialForBackend).mockResolvedValue({
      // Distinct org+cred so the per-(org,cred) BYOK listing cache from the
      // other tests does not satisfy this fetch.
      id: 'cred-zdr',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-org',
      keyFingerprint: 'f',
    })
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 }))
    const catalog = await getCatalogForOrg('org_zdr_byok', { zdrOnly: true })
    expect(catalog).toMatchObject({ zdrOnly: false, zdrApplicable: false, zdr: null })
    expect(catalog.models.map((m) => m.id)).toEqual(['gpt-4o'])
    expect(fetchZdrEndpoints).not.toHaveBeenCalled()
  })

  it('decides applicability from the provider alone, never revealing the key', async () => {
    vi.mocked(getActiveCredentialProvider).mockResolvedValueOnce('openai')
    expect(await isZdrApplicableForOrg('org_1')).toBe(false)
    vi.mocked(getActiveCredentialProvider).mockResolvedValueOnce('openrouter')
    expect(await isZdrApplicableForOrg('org_1')).toBe(true)
    vi.mocked(getActiveCredentialProvider).mockResolvedValueOnce(null)
    expect(await isZdrApplicableForOrg('org_1')).toBe(true)
    expect(resolveActiveCredentialForBackend).not.toHaveBeenCalled()
  })

  it('ZDR applies to the platform key and an OpenRouter key only', () => {
    expect(isZdrApplicableForCredential(null)).toBe(true)
    expect(isZdrApplicableForCredential({ provider: 'openrouter' })).toBe(true)
    expect(isZdrApplicableForCredential({ provider: 'openai' })).toBe(false)
    expect(isZdrApplicableForCredential({ provider: 'azure' })).toBe(false)
    expect(isZdrApplicableForCredential({ provider: 'custom' })).toBe(false)
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
