/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'

import {
  AVATAR_HUES,
  avatarColorStyle,
  avatarHue,
  avatarPaletteIndex,
  personInitials,
} from './avatar-identity'

describe('avatarHue', () => {
  test('is deterministic — the same id is always the same colour', () => {
    const id = 'user_01HZX8Q4M2'
    expect(avatarHue(id)).toBe(avatarHue(id))
    expect(avatarColorStyle(id)).toEqual(avatarColorStyle(id))
  })

  test('always lands on a hue from the curated ring', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(AVATAR_HUES).toContain(avatarHue(`user-${index}`))
    }
  })

  test('different people generally get different colours', () => {
    // Not a promise of uniqueness (10 hues, so collisions exist by design) but
    // the hash must actually spread: a naive char-code sum collapses ids like
    // these onto one bucket.
    const hues = new Set(
      ['u-anna', 'u-markus', 'u-sabine', 'u-klaus', 'u-matthias', 'u-eva'].map(avatarHue),
    )
    expect(hues.size).toBeGreaterThanOrEqual(4)
  })

  test('anagrams and single-character differences do not collide by construction', () => {
    expect(avatarHue('ab')).not.toBe(avatarHue('ba'))
  })

  test('spreads reasonably across the whole ring', () => {
    const seen = new Set<number>()
    for (let index = 0; index < 500; index += 1) seen.add(avatarPaletteIndex(`user_${index}`))
    expect(seen.size).toBe(AVATAR_HUES.length)
  })

  test('an empty or whitespace id still resolves, deterministically', () => {
    expect(avatarPaletteIndex('')).toBe(0)
    expect(avatarPaletteIndex('   ')).toBe(0)
    expect(avatarHue('')).toBe(AVATAR_HUES[0])
  })

  test('ignores surrounding whitespace so a padded id is the same person', () => {
    expect(avatarHue(' u-anna ')).toBe(avatarHue('u-anna'))
  })
})

describe('avatarColorStyle', () => {
  test('mixes the identity hue against theme tokens, so dark mode needs no second palette', () => {
    const style = avatarColorStyle('u-anna')
    expect(style.backgroundColor).toContain('color-mix(in oklch')
    expect(style.backgroundColor).toContain('var(--card)')
    expect(style.color).toContain('var(--foreground)')
  })

  test('carries the person’s hue in both the surface and the ink', () => {
    const hue = avatarHue('u-markus')
    const style = avatarColorStyle('u-markus')
    expect(style.backgroundColor).toContain(`${hue})`)
    expect(style.color).toContain(`${hue})`)
  })

  test('hardcodes no hex or rgb colour', () => {
    const style = avatarColorStyle('u-sabine')
    expect(`${style.backgroundColor} ${style.color}`).not.toMatch(/#|rgb\(/)
  })
})

describe('personInitials', () => {
  test('takes the first letter of the first two name parts', () => {
    expect(personInitials('Anna Weber')).toBe('AW')
    expect(personInitials('Maria Anna von Ebner')).toBe('MA')
  })

  test('handles a single name', () => {
    expect(personInitials('Piloti')).toBe('P')
  })

  test('collapses extra whitespace', () => {
    expect(personInitials('  markus   hofer  ')).toBe('MH')
  })

  test('falls back to a placeholder rather than rendering an empty disc', () => {
    expect(personInitials('')).toBe('?')
    expect(personInitials('   ')).toBe('?')
  })

  test('keeps diacritics rather than stripping them (German is the primary locale)', () => {
    expect(personInitials('Örs Ćurić')).toBe('ÖĆ')
    expect(personInitials('änna weber')).toBe('ÄW')
  })
})
