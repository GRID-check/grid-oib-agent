/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { configFromEnv, runOnce } from './housekeeping-clock.js'

const config = { backendUrl: 'http://aiq-api:8000', internalToken: 'token' }
const job = { route: 'ghost-jobs', timeoutMs: 1000 }

function streak() {
  return { failed: vi.fn(), succeeded: vi.fn() }
}

function silentLog() {
  return { log: vi.fn(), error: vi.fn() }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe('the Compose housekeeping clock', () => {
  it('posts one cycle to the backend route with the internal token', async () => {
    const fetchImpl = vi.fn(async () => response(200, { reaped: [] }))
    const s = streak()
    const result = await runOnce(config, fetchImpl, s, job, silentLog())
    expect(result).toEqual({ reaped: [] })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://aiq-api:8000/v1/maintenance/housekeeping/ghost-jobs',
      expect.objectContaining({ method: 'POST', headers: { 'x-grid-internal-token': 'token' } })
    )
    expect(s.succeeded).toHaveBeenCalledOnce()
  })

  it('counts a transient failure toward the streak instead of logging an error', async () => {
    const log = silentLog()
    const s = streak()
    expect(await runOnce(config, async () => response(503, {}), s, job, log)).toBeNull()
    expect(s.failed).toHaveBeenCalledOnce()
    expect(log.error).not.toHaveBeenCalled()
  })

  it('logs a non-transient failure, such as a rejected token, as an error', async () => {
    const log = silentLog()
    const s = streak()
    expect(await runOnce(config, async () => response(403, {}), s, job, log)).toBeNull()
    expect(log.error).toHaveBeenCalledOnce()
    expect(s.failed).not.toHaveBeenCalled()
  })

  it('treats an unreachable backend as transient', async () => {
    const s = streak()
    const failing = async () => {
      throw new TypeError('fetch failed')
    }
    expect(await runOnce(config, failing, s, job, silentLog())).toBeNull()
    expect(s.failed).toHaveBeenCalledOnce()
  })

  it('refuses to start without a backend URL and a token', () => {
    expect(() => configFromEnv({ BACKEND_URL: 'http://aiq-api:8000' })).toThrow(/GRID_INTERNAL_API_TOKEN/)
    expect(configFromEnv({ BACKEND_URL: 'http://aiq-api:8000/', GRID_INTERNAL_API_TOKEN: 't' })).toEqual({
      backendUrl: 'http://aiq-api:8000',
      internalToken: 't',
    })
  })
})
