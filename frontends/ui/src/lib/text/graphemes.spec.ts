/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { singleLine, stripFormatControls, truncateGraphemes } from './graphemes'

describe('stripFormatControls', () => {
  it('removes bidi overrides and isolates, zero-width characters, the soft hyphen and the BOM', () => {
    expect(stripFormatControls('Rechnung\u202Efdp.exe')).toBe('Rechnungfdp.exe')
    expect(stripFormatControls('\u2066a\u2069\u200Bb\u200D\uFEFFc\u00ADd')).toBe('abcd')
  })

  it('keeps ordinary text, umlauts and emoji with a variation selector', () => {
    expect(stripFormatControls('Pläne 🏗️')).toBe('Pläne 🏗️')
  })
})

describe('singleLine', () => {
  it('turns CR, LF, NUL and C1 controls into one space each run, and trims', () => {
    expect(singleLine(' Plan\r\nBcc: x@y\u0000z\u0085w ')).toBe('Plan Bcc: x@y z w')
  })

  it('collapses the Unicode line and paragraph separators too', () => {
    expect(singleLine('a\u2028b\u2029c')).toBe('a b c')
  })

  it('drops format characters before collapsing, so an override cannot hide a gap', () => {
    expect(singleLine('a \u202E b')).toBe('a b')
  })
})

describe('truncateGraphemes', () => {
  it('leaves text that fits alone', () => {
    expect(truncateGraphemes('Plan', 4, '…')).toBe('Plan')
  })

  it('never splits a surrogate pair', () => {
    expect(truncateGraphemes(`${'x'.repeat(9)}📐`, 10)).toBe('x'.repeat(9))
  })

  it('never splits a family emoji into its members', () => {
    const family = '👨\u200D👩\u200D👧'
    expect(truncateGraphemes(`ab${family}cd`, 6)).toBe('ab')
    expect(truncateGraphemes(`ab${family}cd`, 2 + family.length)).toBe(`ab${family}`)
  })

  it('never separates a base letter from its combining mark', () => {
    expect(truncateGraphemes('Pla\u0308ne', 3)).toBe('Pl')
  })

  it('counts the ellipsis in the budget', () => {
    expect(truncateGraphemes('abcdef', 4, '…')).toBe('abc…')
  })

  it('answers the empty string when not even the ellipsis fits', () => {
    expect(truncateGraphemes('abcdef', 0, '…')).toBe('')
  })
})
