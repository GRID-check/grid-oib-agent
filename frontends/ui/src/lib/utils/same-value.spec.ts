/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { sameValue } from './same-value'

describe('sameValue', () => {
  it('holds a value rebuilt from the same facts the same, and a changed one different', () => {
    expect(sameValue({ people: [{ name: 'Anna', page: 2 }], piloti: null }, { people: [{ name: 'Anna', page: 2 }], piloti: null })).toBe(true)
    expect(sameValue({ people: [{ name: 'Anna', page: 2 }] }, { people: [{ name: 'Anna', page: 3 }] })).toBe(false)
    expect(sameValue(['a'], ['a'])).toBe(true)
  })

  it('compares what is not an object by value, and never an object with what is not one', () => {
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true)
    expect(sameValue('2', 2)).toBe(false)
    expect(sameValue(null, {})).toBe(false)
    expect(sameValue('{}', {})).toBe(false)
  })
})
