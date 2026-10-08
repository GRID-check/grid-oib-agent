/**
 * Where the shared internal token is allowed to travel.
 *
 * `GRID_INTERNAL_API_TOKEN` is a bearer secret. Plain HTTP is the intended
 * transport to a sibling service on the compose/cluster network, so the rule
 * cannot simply be "https only" — that would withhold the token from every
 * real deployment. It has to be "TLS, or provably not leaving this network".
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _clearDefaultsCache,
  getGroupDefaultSources,
  getGroupDefaults,
  isTokenSafeDestination,
  splitGroupDefault,
} from './backend-defaults'

vi.mock('server-only', () => ({}))

const getPlatformModelDefaults = vi.fn()
vi.mock('./platform-defaults', () => ({ getPlatformModelDefaults: () => getPlatformModelDefaults() }))

describe('isTokenSafeDestination', () => {
  it('allows the deployment shapes that actually ship', () => {
    // Compose/Kubernetes short names, loopback, and the documented default.
    for (const url of [
      'http://aiq-agent:8000',
      'http://backend:8000',
      'http://localhost:8000',
      'http://127.0.0.1:8000',
      'http://10.4.1.7:8000',
      'http://172.20.0.3:8000',
      'http://192.168.1.5:8000',
      'http://aiq-agent.grid.svc.cluster.local:8000',
      'https://backend.example.com',
    ]) {
      expect(isTokenSafeDestination(url), url).toBe(true)
    }
  })

  it('withholds the token from a public host over cleartext', () => {
    for (const url of [
      'http://backend.example.com',
      'http://8.8.8.8:8000',
      'http://203.0.113.10',
      'not a url',
      '',
    ]) {
      expect(isTokenSafeDestination(url), url).toBe(false)
    }
  })

  it('rejects a non-http scheme outright', () => {
    // No reason for the token to ride a scheme whose transport we have not
    // reasoned about.
    expect(isTokenSafeDestination('ftp://backend:8000')).toBe(false)
    expect(isTokenSafeDestination('file:///etc/passwd')).toBe(false)
  })
})

describe('getGroupDefaultSources — the inherited-default merge', () => {
  afterEach(() => {
    _clearDefaultsCache()
    vi.unstubAllGlobals()
  })

  const backendReports = (llms: Record<string, string>) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ llms }) }))

  it('takes the platform default where one is pinned, the workflow model otherwise, and says which', async () => {
    backendReports({ clarifier_llm: 'yaml/clarifier', research_llm: 'yaml/research' })
    getPlatformModelDefaults.mockResolvedValue({ shallow_research: 'platform/research' })
    const sources = await getGroupDefaultSources()
    expect(sources.clarifier).toEqual({ model: 'yaml/clarifier', source: 'workflow' })
    expect(sources.shallow_research).toEqual({ model: 'platform/research', source: 'platform' })
    expect(sources.memory_reflection).toEqual({ model: null, source: null })
    // `getGroupDefaults` is the same merge without the source.
    expect((await getGroupDefaults()).shallow_research).toBe('platform/research')
  })

  it('falls back to the workflow layer when the platform table cannot be read', async () => {
    backendReports({ research_llm: 'yaml/research' })
    getPlatformModelDefaults.mockRejectedValue(new Error('db down'))
    expect((await getGroupDefaultSources()).shallow_research).toEqual({ model: 'yaml/research', source: 'workflow' })
  })

  it('splits a multi-LLM group default into its ids', () => {
    expect(splitGroupDefault('a/x, b/y')).toEqual(['a/x', 'b/y'])
    expect(splitGroupDefault(null)).toEqual([])
  })
})
