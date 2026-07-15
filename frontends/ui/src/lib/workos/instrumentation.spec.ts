import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { timedWorkOSCall } from './instrumentation'

describe('timedWorkOSCall', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete process.env.GRID_AUTHZ_SLOW_CALL_MS
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Run a call that resolves only after `elapsedMs` of fake time passes. */
  async function runFor<T>(elapsedMs: number, result: () => T | Promise<T>): Promise<T> {
    const promise = timedWorkOSCall('authorization.check project:edit', async () => {
      await vi.advanceTimersByTimeAsync(elapsedMs)
      return result()
    })
    return promise
  }

  it('stays silent on the fast path (below threshold)', async () => {
    await expect(runFor(100, () => 'ok')).resolves.toBe('ok')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('WARNs when a call exceeds the default 2s threshold, naming the leg and duration', async () => {
    await expect(runFor(2500, () => 'ok')).resolves.toBe('ok')
    expect(console.warn).toHaveBeenCalledTimes(1)
    const message = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(message).toContain('authorization.check project:edit')
    expect(message).toContain('2500ms')
  })

  it('WARNs on a slow FAILURE too (a timeout that then throws still names the leg)', async () => {
    const boom = new Error('Request timeout after 30000ms')
    await expect(
      runFor(30_000, () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect((console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('30000ms')
  })

  it('honors an env-tuned threshold', async () => {
    process.env.GRID_AUTHZ_SLOW_CALL_MS = '5000'
    await expect(runFor(3000, () => 'ok')).resolves.toBe('ok')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('is fully disabled when the threshold is 0', async () => {
    process.env.GRID_AUTHZ_SLOW_CALL_MS = '0'
    await expect(runFor(60_000, () => 'ok')).resolves.toBe('ok')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('falls back to the default for a non-numeric threshold', async () => {
    process.env.GRID_AUTHZ_SLOW_CALL_MS = 'nonsense'
    await expect(runFor(2500, () => 'ok')).resolves.toBe('ok')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
