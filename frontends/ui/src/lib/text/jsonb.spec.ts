import { describe, expect, it } from 'vitest'
import { stripJsonNullBytes } from './jsonb'

const NUL = '\u0000'

describe('stripJsonNullBytes', () => {
  it('strips NUL from a plain string', () => {
    expect(stripJsonNullBytes(`a${NUL}b`)).toBe('ab')
  })

  it('leaves strings without NUL untouched', () => {
    expect(stripJsonNullBytes('plain')).toBe('plain')
  })

  it('strips NUL deep inside objects and arrays', () => {
    expect(
      stripJsonNullBytes({
        cards: [{ content: `x${NUL}y` }],
        tags: ['a', 'b'],
      })
    ).toEqual({ cards: [{ content: 'xy' }], tags: ['a', 'b'] })
  })

  it('strips NUL from object keys as well as values', () => {
    expect(stripJsonNullBytes({ [`ke${NUL}y`]: 'v' })).toEqual({ key: 'v' })
  })

  it('passes non-string leaves through with their types intact', () => {
    expect(stripJsonNullBytes({ n: 3, b: false, z: null })).toEqual({ n: 3, b: false, z: null })
    expect(stripJsonNullBytes(42)).toBe(42)
    expect(stripJsonNullBytes(null)).toBeNull()
  })

  it('strips lone surrogates but keeps valid pairs', () => {
    // Built from char codes: a lone half has no literal worth writing.
    const loneHigh = String.fromCharCode(0xd800)
    const loneLow = String.fromCharCode(0xdc00)
    const pair = String.fromCharCode(0xd83c, 0xdfa1)

    expect(stripJsonNullBytes(`a${loneHigh}b`)).toBe('ab')
    expect(stripJsonNullBytes(`a${loneLow}b`)).toBe('ab')
    expect(stripJsonNullBytes(`a${pair}b`)).toBe(`a${pair}b`)
  })
})
