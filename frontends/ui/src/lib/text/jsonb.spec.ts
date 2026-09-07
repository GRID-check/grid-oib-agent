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
})
