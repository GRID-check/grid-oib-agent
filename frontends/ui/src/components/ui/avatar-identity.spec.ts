/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import {
  AVATAR_HUES,
  avatarColorStyle,
  avatarHue,
  avatarPaletteIndex,
  identityInk,
  personInitials,
} from './avatar-identity'

/** The relative luminance of an `oklch(L C h)` colour, through OKLab to linear sRGB (clipped to the gamut). */
function luminanceOf(oklch: string): number {
  const [L, C, h] = (/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(oklch) ?? []).slice(1).map(Number)
  const a = C * Math.cos((h * Math.PI) / 180)
  const b = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((value) => Math.min(1, Math.max(0, value)))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/** WCAG contrast between two `oklch()` colours, or of white text on one. */
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const whiteOn = (oklch: string): number => contrast('oklch(1 0 0)', oklch)

/** `--background` as `styles/tokens.css` sets it, in the light theme (`:root`) or the dark one (`.dark`). */
function backgroundToken(theme: 'light' | 'dark'): string {
  const css = readFileSync(fileURLToPath(new URL('../../styles/tokens.css', import.meta.url)), 'utf8')
  const block = theme === 'dark' ? css.slice(css.indexOf('.dark {')) : css
  const value = /--background:\s*(oklch\([^)]*\))/.exec(block)?.[1]
  if (!value) throw new Error(`no --background for ${theme} in tokens.css`)
  return value
}

/** One user id per hue of the ring. */
const idOnHue = (hue: number): string =>
  [...Array(500).keys()].map((index) => `user-${index}`).find((candidate) => avatarHue(candidate) === hue) ?? ''

describe('identityInk', () => {
  test('carries white text at 4.5:1 or more on every hue of the ring', () => {
    // A name tag, a cursor chat and a filled pin are white words on this ink.
    for (const hue of AVATAR_HUES) {
      const id = idOnHue(hue)
      expect(id, `a user id on hue ${hue}`).not.toBe('')
      expect(whiteOn(identityInk(id)), `hue ${hue}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('as the ring round a followed colleague, stands out 3:1 from the page ground in both themes (WCAG 1.4.11)', () => {
    for (const theme of ['light', 'dark'] as const) {
      const ground = backgroundToken(theme)
      for (const hue of AVATAR_HUES) {
        expect(contrast(identityInk(idOnHue(hue)), ground), `${theme}, hue ${hue}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
})

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
