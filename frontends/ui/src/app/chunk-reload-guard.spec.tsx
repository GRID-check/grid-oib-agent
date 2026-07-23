import { describe, expect, it } from 'vitest'

import { isChunkLoadError } from './chunk-reload-guard'

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
