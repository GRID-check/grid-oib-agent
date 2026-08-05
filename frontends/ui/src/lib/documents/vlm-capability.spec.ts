/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

import { isVlmConfigured, __resetVlmCapabilityCache } from './vlm-capability'

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
  __resetVlmCapabilityCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const okJson = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })

describe('isVlmConfigured', () => {
  it('probes /v1/data_sources with a bounded timeout signal', async () => {
    mockFetch.mockResolvedValue(okJson({ data_sources: [], vlm_available: true }))

    const result = await isVlmConfigured()

    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://backend:8000/v1/data_sources')
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it('reports false when vlm_available is false or absent', async () => {
    mockFetch.mockResolvedValue(okJson({ data_sources: [], vlm_available: false }))
    expect(await isVlmConfigured()).toBe(false)

    __resetVlmCapabilityCache()
    mockFetch.mockResolvedValue(okJson({ data_sources: [] }))
    expect(await isVlmConfigured()).toBe(false)
  })

  it('fails closed (false) on a non-OK response, a network error, and a bare-array shape', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) })
    expect(await isVlmConfigured()).toBe(false)

    __resetVlmCapabilityCache()
    mockFetch.mockRejectedValue(new Error('backend down'))
    expect(await isVlmConfigured()).toBe(false)

    __resetVlmCapabilityCache()
    mockFetch.mockResolvedValue(okJson([{ id: 'web' }]))
    expect(await isVlmConfigured()).toBe(false)
  })

  it('caches within the TTL and re-probes after it expires', async () => {
    mockFetch.mockResolvedValue(okJson({ data_sources: [], vlm_available: true }))

    const t0 = 1_000_000
    expect(await isVlmConfigured(t0)).toBe(true)
    // Second call inside the TTL window uses the cache — no extra fetch.
    expect(await isVlmConfigured(t0 + 10_000)).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Past the TTL, it re-probes and can observe a changed capability.
    mockFetch.mockResolvedValue(okJson({ data_sources: [], vlm_available: false }))
    expect(await isVlmConfigured(t0 + 60_000)).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
