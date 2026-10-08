import { describe, expect, it } from 'vitest'
import { escapeLikePattern, likeContains } from './like-pattern'

describe('escapeLikePattern', () => {
  it('makes %, _ and the backslash literal', () => {
    expect(escapeLikePattern('100 %')).toBe('100 \\%')
    expect(escapeLikePattern('WC_1')).toBe('WC\\_1')
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
  })

  it('escapes the backslash before the wildcards, so it cannot escape an escape', () => {
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern('Fluchtweg GK 4')).toBe('Fluchtweg GK 4')
  })
})

describe('likeContains', () => {
  it('wraps the escaped value in substring wildcards', () => {
    expect(likeContains('R_60')).toBe('%R\\_60%')
  })
})
