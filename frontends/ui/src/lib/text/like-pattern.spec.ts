import { describe, expect, it } from 'vitest'
import { escapeLikePattern } from './like-pattern'

describe('escapeLikePattern', () => {
  it('escapes the LIKE wildcards and the escape character itself', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
    expect(escapeLikePattern('C:\\plans')).toBe('C:\\\\plans')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('Bauantrag Wien')).toBe('Bauantrag Wien')
  })
})
