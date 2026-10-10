import { describe, expect, it } from 'vitest'
import { parsePhotoCapture } from './photo-capture'

describe('parsePhotoCapture', () => {
  it('maps the snake_case backend facts to camelCase', () => {
    expect(
      parsePhotoCapture({
        captured_at: '2026-03-14T09:21:00',
        latitude: 47.0707,
        longitude: 15.4395,
        camera: 'Apple iPhone 15',
      })
    ).toEqual({
      capturedAt: '2026-03-14T09:21:00',
      latitude: 47.0707,
      longitude: 15.4395,
      camera: 'Apple iPhone 15',
    })
  })

  it('keeps the facts that are valid and drops the rest', () => {
    expect(parsePhotoCapture({ captured_at: '2026-03-14T09:21:00', latitude: 'north', camera: '' })).toEqual({
      capturedAt: '2026-03-14T09:21:00',
    })
  })

  it('keeps coordinates only when both are finite numbers in range', () => {
    expect(parsePhotoCapture({ latitude: 47.07, longitude: 15.44 })).toEqual({ latitude: 47.07, longitude: 15.44 })
    expect(parsePhotoCapture({ latitude: 47.07 })).toBeNull()
    expect(parsePhotoCapture({ longitude: 15.44, camera: 'X' })).toEqual({ camera: 'X' })
    expect(parsePhotoCapture({ latitude: Number.NaN, longitude: 15.44 })).toBeNull()
    expect(parsePhotoCapture({ latitude: Number.POSITIVE_INFINITY, longitude: 15.44 })).toBeNull()
    expect(parsePhotoCapture({ latitude: 91, longitude: 15.44 })).toBeNull()
    expect(parsePhotoCapture({ latitude: 47.07, longitude: -181 })).toBeNull()
  })

  it('drops a non-string capture time and a non-string camera', () => {
    expect(parsePhotoCapture({ captured_at: 1_710_000_000, camera: ['Canon'] })).toBeNull()
    expect(parsePhotoCapture({ captured_at: '' })).toBeNull()
  })

  it('returns null for anything that is not an object with usable facts', () => {
    expect(parsePhotoCapture(null)).toBeNull()
    expect(parsePhotoCapture(undefined)).toBeNull()
    expect(parsePhotoCapture('47.07,15.44')).toBeNull()
    expect(parsePhotoCapture(42)).toBeNull()
    expect(parsePhotoCapture([47.07, 15.44])).toBeNull()
    expect(parsePhotoCapture({})).toBeNull()
  })
})
