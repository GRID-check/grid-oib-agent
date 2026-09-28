/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { meetsLimit, parseLimit, parseNumber, parseQuantity, trailingLimit } from './quantities'

describe('parseNumber', () => {
  it('reads German and English separators', () => {
    expect(parseNumber('1.200')).toBe(1200)
    expect(parseNumber('1,10')).toBe(1.1)
    expect(parseNumber('1.250,5')).toBe(1250.5)
    expect(parseNumber('1,250.5')).toBe(1250.5)
    expect(parseNumber('1 200')).toBe(1200)
    expect(parseNumber('1.25')).toBe(1.25)
  })
})

describe('parseQuantity', () => {
  it('reads a number with one unit', () => {
    expect(parseQuantity('1.200 m²')).toEqual({ value: 1200, unit: 'm²' })
    expect(parseQuantity('3,5 %')).toEqual({ value: 3.5, unit: '%' })
    expect(parseQuantity('0,35 W/m²K')).toEqual({ value: 0.35, unit: 'W/m²K' })
    expect(parseQuantity('5')).toEqual({ value: 5, unit: '' })
  })

  it('is not fooled by a class or a sentence', () => {
    expect(parseQuantity('EI 60')).toBeNull()
    expect(parseQuantity('R 90')).toBeNull()
    expect(parseQuantity('3 Geschoße über dem Gelände, davon eines teilweise')).toBeNull()
  })
})

describe('parseLimit and meetsLimit', () => {
  it('reads the bound and holds a value to it', () => {
    expect(parseLimit('≥ 55 dB')).toMatchObject({ bound: 'min', value: 55, unit: 'dB' })
    expect(parseLimit('max. 1.200 m²')).toMatchObject({ bound: 'max', value: 1200 })
    expect(parseLimit('< 0,35 W/m²K')).toMatchObject({ bound: 'max', strict: true })
    expect(meetsLimit({ value: 57, unit: 'dB' }, parseLimit('≥ 55 dB')!)).toBe(true)
    expect(meetsLimit({ value: 1380, unit: 'm²' }, parseLimit('max. 1.200 m²')!)).toBe(false)
    expect(meetsLimit({ value: 0.35, unit: 'W/m²K' }, parseLimit('< 0,35 W/m²K')!)).toBe(false)
  })

  it('refuses to compare different units', () => {
    expect(meetsLimit({ value: 110, unit: 'cm' }, parseLimit('≥ 1,00 m')!)).toBeNull()
  })

  it('reads a range as no value, and a unit-less limit as no comparison for a value with a unit', () => {
    expect(parseQuantity('2-3')).toBeNull()
    expect(parseQuantity('4–5 m')).toBeNull()
    expect(meetsLimit({ value: 45, unit: 'm' }, parseLimit('≤ 40')!)).toBeNull()
    expect(meetsLimit({ value: 4, unit: '' }, parseLimit('max. 4')!)).toBe(true)
  })
})

describe('trailingLimit', () => {
  it('reads a limit written at the end of a label', () => {
    expect(trailingLimit('Luftschalldämmung ≥ 55 dB')).toMatchObject({ text: '≥ 55 dB', limit: { bound: 'min', value: 55, unit: 'dB' } })
    expect(trailingLimit('Fluchtweglänge max. 40 m')).toMatchObject({ limit: { bound: 'max', value: 40, unit: 'm' } })
  })

  it('reads nothing from a label without one, or with words after it', () => {
    expect(trailingLimit('Luftschalldämmung')).toBeNull()
    expect(trailingLimit('≥ 55 dB je Wohnung')).toBeNull()
  })
})
