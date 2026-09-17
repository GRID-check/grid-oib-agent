/**
 * @vitest-environment node
 */
/**
 * The document image route's deflection contract (#366): every failure serves
 * these exact bytes with a 200, because the Next image optimizer ignores
 * status codes and sniffs every non-empty body as image magic. A placeholder
 * the optimizer itself rejects would trade one "isn't a valid image" for
 * another, so this spec pins that the bytes are a real PNG.
 */
import { describe, expect, it } from 'vitest'
import {
  FALLBACK_IMAGE_CONTENT_TYPE,
  fallbackImageBytes,
  fallbackImageResponse,
} from './image-fallback'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe('document image fallback', () => {
  it('serves non-empty PNG bytes', () => {
    const bytes = fallbackImageBytes()

    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(Array.from(bytes.subarray(0, 8))).toEqual(PNG_MAGIC)
  })

  it('returns the same bytes on every call', () => {
    expect(fallbackImageBytes()).toEqual(fallbackImageBytes())
  })

  it('responds 200 with the placeholder bytes and a short private cache', async () => {
    const response = fallbackImageResponse()

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(FALLBACK_IMAGE_CONTENT_TYPE)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fallbackImageBytes())
  })
})
