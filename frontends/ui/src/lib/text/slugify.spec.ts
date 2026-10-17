/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { latinize } from './latinize'
import { slugify } from './slugify'

/**
 * The two copies `slugify` replaced, verbatim, as the oracle it is checked
 * against: moving a caller onto the shared function must not change one byte
 * of what it produced.
 */
function legacyNormEntrySlug(value: string): string {
  return latinize(value.trim())
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function legacyProjectSlug(projectName: string): string {
  const slug = latinize(projectName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, 30).replace(/-+$/, '')
}

const CORPUS = [
  '',
  '   ',
  'Wohnbau Hietzing',
  'Straßenbau Süd / Los 2',
  '  ÖNORM B 1600 Dvořák  ',
  'Øresund Łódź',
  'Ærø',
  'ﬁnal ½ ＡＢＣ',
  'Sanierung Schule Am.Park.Weg Bauteil A und B und C',
  'abcdefghijklmnopqrstuvwxyz-1234 5678',
  'abcdefghijklmnopqrstuvwxyzabc d',
  '東京プロジェクト',
  '---Hallo---Welt---',
  ' nbsp em space\t',
  'äpfel (macOS decomposed)',
  'ẞ GROSS',
  'OIB-RL 2 · Brandschutz — 2023',
]

describe('slugify', () => {
  it('latinizes, lowercases and hyphenates', () => {
    expect(slugify('Straßenbau Süd / Los 2')).toBe('strassenbau-sued-los-2')
    expect(slugify('ÖNORM B 1600 Dvořák')).toBe('oenorm-b-1600-dvorak')
  })

  it('is empty when nothing Latin survives', () => {
    expect(slugify('東京プロジェクト')).toBe('')
  })

  it('cuts to max without leaving a trailing hyphen', () => {
    expect(slugify('abcdefghij klmno', { max: 11 })).toBe('abcdefghij')
    expect(slugify('abc', { max: 30 })).toBe('abc')
  })

  it('produces byte for byte what the norms catalog editor produced', () => {
    for (const value of CORPUS) expect(slugify(value), value).toBe(legacyNormEntrySlug(value))
  })

  it('produces byte for byte what the project mail slug produced', () => {
    for (const value of CORPUS) expect(slugify(value, { max: 30 }), value).toBe(legacyProjectSlug(value))
  })
})
