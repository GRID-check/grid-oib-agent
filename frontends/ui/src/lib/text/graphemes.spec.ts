/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { stripFormatControls, truncateGraphemes } from './graphemes'

describe('stripFormatControls', () => {
  it('removes bidi overrides and isolates, zero-width characters and the BOM', () => {
    expect(stripFormatControls('Rechnung‮fdp.exe')).toBe('Rechnungfdp.exe')
    expect(stripFormatControls('⁦a⁩​b‍﻿')).toBe('ab')
  })

  it('keeps ordinary text, umlauts and emoji', () => {
    expect(stripFormatControls('Pläne 🏗️')).toBe('Pläne 🏗️')
  })
})

describe('truncateGraphemes', () => {
  it('leaves text that fits alone', () => {
    expect(truncateGraphemes('Plan', 4, '…')).toBe('Plan')
  })

  it('never splits a surrogate pair', () => {
    const cut = truncateGraphemes(`${'x'.repeat(9)}📐`, 10)
    expect(cut).toBe('x'.repeat(9))
  })

  it('never splits a family emoji into its members', () => {
    const family = '👨‍👩‍👧'
    expect(truncateGraphemes(`ab${family}cd`, 6)).toBe('ab')
    expect(truncateGraphemes(`ab${family}cd`, 2 + family.length)).toBe(`ab${family}`)
  })

  it('counts the ellipsis in the budget', () => {
    expect(truncateGraphemes('abcdef', 4, '…')).toBe('abc…')
  })
})
