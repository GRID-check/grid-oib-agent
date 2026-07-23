import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChunkReloadGuard, isChunkLoadError } from './chunk-reload-guard'

const RELOAD_TS_KEY = 'grid:chunk-reload-ts'

/** Dispatch a window `error` event carrying `error` (what webpack ChunkLoadError surfaces as). */
function dispatchError(error: unknown): void {
  const event = new Event('error') as ErrorEvent
  Object.defineProperty(event, 'error', { configurable: true, value: error })
  window.dispatchEvent(event)
}

/** Dispatch a window `unhandledrejection` event carrying `reason` (a failed dynamic import). */
function dispatchRejection(reason: unknown): void {
  const event = new Event('unhandledrejection') as PromiseRejectionEvent
  Object.defineProperty(event, 'reason', { configurable: true, value: reason })
  window.dispatchEvent(event)
}

const CHUNK_ERROR = { name: 'ChunkLoadError', message: 'Loading chunk 42 failed.' }

describe('isChunkLoadError', () => {
  it('matches ChunkLoadError by name (webpack) — the rolling-deploy case', () => {
    expect(isChunkLoadError({ name: 'ChunkLoadError', message: 'Loading chunk 42 failed.' })).toBe(true)
  })

  it('matches a real Error instance named ChunkLoadError', () => {
    const err = new Error('Loading chunk 3 failed.')
    err.name = 'ChunkLoadError'
    expect(isChunkLoadError(err)).toBe(true)
  })

  it('matches JS chunk load-failure messages', () => {
    expect(isChunkLoadError({ message: 'Loading chunk 5 failed.' })).toBe(true)
  })

  it('matches CSS chunk load-failure messages', () => {
    expect(isChunkLoadError({ message: 'Loading CSS chunk 7 failed.' })).toBe(true)
  })

  it('matches failed dynamic imports (vite/modern bundlers)', () => {
    expect(isChunkLoadError({ message: 'Failed to fetch dynamically imported module: /_next/x.js' })).toBe(true)
  })

  it('does NOT match unrelated errors', () => {
    expect(isChunkLoadError(new Error('Network request failed'))).toBe(false)
    expect(isChunkLoadError({ name: 'TypeError', message: 'x is not a function' })).toBe(false)
  })

  it('is safe on null / undefined / non-error values', () => {
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
    expect(isChunkLoadError('a string')).toBe(false)
  })
})

describe('ChunkReloadGuard', () => {
  let reload: ReturnType<typeof vi.fn>

  beforeEach(() => {
    window.sessionStorage.clear()
    reload = vi.fn()
    vi.spyOn(window.location, 'reload').mockImplementation(() => {
      reload()
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reloads once on a chunk-load `error` event during a rollout', () => {
    render(<ChunkReloadGuard />)

    dispatchError(CHUNK_ERROR)

    expect(reload).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(RELOAD_TS_KEY)).not.toBeNull()
  })

  it('reloads on a failed dynamic import surfaced as an unhandled rejection', () => {
    render(<ChunkReloadGuard />)

    dispatchRejection({ message: 'Failed to fetch dynamically imported module: /_next/x.js' })

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated errors', () => {
    render(<ChunkReloadGuard />)

    dispatchError(new Error('Network request failed'))
    dispatchRejection(new Error('Something else'))

    expect(reload).not.toHaveBeenCalled()
  })

  it('is loop-safe: a second chunk error within the min gap does not reload again', () => {
    render(<ChunkReloadGuard />)

    dispatchError(CHUNK_ERROR)
    dispatchError(CHUNK_ERROR)

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads again once the min gap has elapsed', () => {
    window.sessionStorage.setItem(RELOAD_TS_KEY, String(Date.now() - 20_000))
    render(<ChunkReloadGuard />)

    dispatchError(CHUNK_ERROR)

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('skips the reload when sessionStorage is unavailable (private mode etc.)', () => {
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('sessionStorage denied')
    })
    render(<ChunkReloadGuard />)

    dispatchError(CHUNK_ERROR)

    expect(reload).not.toHaveBeenCalled()
  })

  it('removes its listeners on unmount', () => {
    const { unmount } = render(<ChunkReloadGuard />)
    unmount()

    dispatchError(CHUNK_ERROR)

    expect(reload).not.toHaveBeenCalled()
  })
})
