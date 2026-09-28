/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { directiveDepths, energyClass, normalizeDirectiveFences, stripDirectives } from './answer-directives'

describe('stripDirectives: the answer as plain Markdown, for copy and export', () => {
  it('keeps a check as the table it wraps', () => {
    const check = ':::check\n| A | Ist | Soll |\n|---|---|---|\n| x | 1 m | ≥ 1 m |\n:::'
    expect(stripDirectives(check)).toBe('| A | Ist | Soll |\n|---|---|---|\n| x | 1 m | ≥ 1 m |')
  })

  it('prints a details block open, under its label in bold', () => {
    expect(stripDirectives(':::details[Herleitung]\nAus Tabelle 2.\n:::')).toBe('**Herleitung**\n\nAus Tabelle 2.')
  })

  it('writes markers and energy classes out as words', () => {
    expect(stripDirectives('1. Einreichung :current')).toBe('1. Einreichung (aktuell)')
    expect(stripDirectives('- GK 4 :applies')).toBe('- GK 4 (trifft zu)')
    expect(stripDirectives('| Kriterium | Variante B :recommended |')).toBe('| Kriterium | Variante B (empfohlen) |')
    expect(stripDirectives('Klasse :energy-class[b], sonst nichts.')).toBe('Klasse B, sonst nichts.')
  })

  it('leaves text that only looks like a directive, and code, exactly as written', () => {
    const text = 'Um 10:30 Uhr, Hinweis:Achtung, :unbekannt[x].\n\n```\n:::check\n:current\n```'
    expect(stripDirectives(text)).toBe(text)
    expect(stripDirectives('Siehe `:current` im Code.')).toBe('Siehe `:current` im Code.')
  })
})

describe('normalizeDirectiveFences: nesting without counting colons', () => {
  it('lengthens the outer fence of a nested block', () => {
    const nested = ':::procedure\n1. Schritt\n   :::details[Was]\n   Inhalt\n   :::\n2. Schritt\n:::'
    expect(normalizeDirectiveFences(nested)).toBe(
      '::::procedure\n1. Schritt\n   :::details[Was]\n   Inhalt\n   :::\n2. Schritt\n::::'
    )
  })

  it('leaves unnested blocks and code alone', () => {
    const flat = ':::details[A]\nx\n:::\n\n```\n:::procedure\n:::details\n```'
    expect(normalizeDirectiveFences(flat)).toBe(flat)
  })

  it('keeps an unclosed (streamed) block open', () => {
    expect(normalizeDirectiveFences(':::procedure\n1. a\n   :::details[b]\n   c')).toBe(
      '::::procedure\n1. a\n   :::details[b]\n   c'
    )
  })
})

describe('directiveDepths', () => {
  it('counts the blocks open before each line; a stray closer closes nothing', () => {
    expect(directiveDepths([':::', ':::check', '| a |', ':::', 'x'])).toEqual([0, 0, 1, 1, 0])
  })
})

describe('energyClass', () => {
  it('accepts A++ … G, however written, and nothing else', () => {
    expect(energyClass(' a+ ')).toBe('A+')
    expect(energyClass('G')).toBe('G')
    expect(energyClass('H')).toBeNull()
  })
})
