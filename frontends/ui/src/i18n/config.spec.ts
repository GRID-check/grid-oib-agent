/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { isLocale, resolveLocale, defaultLocale, locales } from './config'

describe('isLocale', () => {
  test('accepts supported locales', () => {
    expect(isLocale('en')).toBe(true)
    expect(isLocale('de')).toBe(true)
  })

  test('rejects unsupported values', () => {
    expect(isLocale('fr')).toBe(false)
    expect(isLocale('')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
    expect(isLocale(42)).toBe(false)
  })
})

describe('resolveLocale', () => {
  test('returns a supported locale as-is', () => {
    expect(resolveLocale('de')).toBe('de')
  })

  test('matches the primary subtag of a BCP-47 tag', () => {
    expect(resolveLocale('de-DE')).toBe('de')
    expect(resolveLocale('en-US')).toBe('en')
  })

  test('falls back to the default for anything unsupported', () => {
    expect(resolveLocale('fr-FR')).toBe(defaultLocale)
    expect(resolveLocale(null)).toBe(defaultLocale)
    expect(resolveLocale(123)).toBe(defaultLocale)
  })
})

describe('locales', () => {
  test('includes the default locale', () => {
    expect(locales).toContain(defaultLocale)
  })
})
