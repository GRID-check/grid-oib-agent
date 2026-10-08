/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { isTraceId, langfuseApiConfig, langfuseProjectUrl, langfuseTraceUrl, langfuseUiConfig } from './config'

const TRACE = '6135ac80f26d5f7dab0f1633fe313293'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('langfuseApiConfig', () => {
  it('needs both keys and the host', () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-1')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-1')
    vi.stubEnv('LANGFUSE_HOST', 'http://langfuse-web:3000/')

    expect(langfuseApiConfig()).toEqual({
      publicKey: 'pk-lf-1',
      secretKey: 'sk-lf-1',
      baseUrl: 'http://langfuse-web:3000',
    })
  })

  /**
   * The SDK's own default host is Langfuse Cloud. Keys without a host must not
   * fall through to it: votes carry tenant text, and ADR-0044 keeps that in the
   * cluster.
   */
  it('is null with keys but no host, rather than defaulting to Langfuse Cloud', () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-1')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-1')
    vi.stubEnv('LANGFUSE_HOST', '')
    expect(langfuseApiConfig()).toBeNull()
  })

  it('is null without keys', () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-1')
    vi.stubEnv('LANGFUSE_HOST', 'http://langfuse-web:3000')
    expect(langfuseApiConfig()).toBeNull()
  })
})

describe('trace and project URLs', () => {
  const ui = { publicUrl: 'https://langfuse.example.at', projectId: 'grid' }

  it("builds the trace page Langfuse's own SDK links to", () => {
    expect(langfuseTraceUrl(TRACE, ui)).toBe(`https://langfuse.example.at/project/grid/traces/${TRACE}`)
    expect(langfuseProjectUrl(ui)).toBe('https://langfuse.example.at/project/grid')
  })

  it('is null without a trace id, or for something that is not one', () => {
    for (const traceId of [null, undefined, '', 'abc', TRACE.toUpperCase(), `${TRACE}0`]) {
      expect(langfuseTraceUrl(traceId, ui)).toBeNull()
    }
  })

  it('is null when the UI is not configured', () => {
    expect(langfuseTraceUrl(TRACE, null)).toBeNull()
    expect(langfuseProjectUrl(null)).toBeNull()
  })

  it('reads the UI from the environment, trailing slash and all', () => {
    vi.stubEnv('LANGFUSE_PUBLIC_URL', 'https://langfuse.example.at//')
    vi.stubEnv('LANGFUSE_PROJECT_ID', 'grid')
    expect(langfuseUiConfig()).toEqual(ui)
    expect(langfuseTraceUrl(TRACE)).toBe(`https://langfuse.example.at/project/grid/traces/${TRACE}`)

    vi.stubEnv('LANGFUSE_PROJECT_ID', '')
    expect(langfuseUiConfig()).toBeNull()
  })

  it('escapes the project id into the path', () => {
    expect(langfuseProjectUrl({ publicUrl: 'https://l.example', projectId: 'a/b' })).toBe(
      'https://l.example/project/a%2Fb'
    )
  })
})

describe('isTraceId', () => {
  it('accepts exactly 32 lowercase hex digits, the spelling the agent writes', () => {
    expect(isTraceId(TRACE)).toBe(true)
    expect(isTraceId('6135ac80-f26d-5f7d-ab0f-1633fe313293')).toBe(false)
    expect(isTraceId(42)).toBe(false)
  })
})
