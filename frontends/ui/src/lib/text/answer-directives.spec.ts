/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import {
  PROJECT_KEYS,
  casesBy,
  directiveDepths,
  energyClass,
  isDirectiveBlock,
  normalizeDirectiveFences,
  projectKeysIn,
  stripDirectives,
} from './answer-directives'

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

describe('project bindings', () => {
  it('lists the keys an answer binds, in order, with the by= of a cases block', () => {
    const answer = [
      'In :project[state] mit :project[escape_level_m].',
      ':::cases{by=building_class}',
      '| GK | Stand |',
      ':::',
      'Wieder :project[state], unbekannt :project[parcel_area_m2], `:project[use]` ist Code.',
      '```',
      ':project[storeys]',
      '```',
    ].join('\n')
    expect(projectKeysIn(answer)).toEqual(['state', 'escape_level_m', 'building_class'])
  })

  it('reads by= only when it names a key', () => {
    expect(casesBy('{by=escape_level_m}')).toBe('escape_level_m')
    expect(casesBy('{by="building_class"}')).toBe('building_class')
    expect(casesBy('{by=lage}')).toBeNull()
  })

  it('prints a binding as the value the surface resolves, else as its key', () => {
    const text = 'GK :project[building_class], FN :project[escape_level_m], X :project[nope].'
    expect(stripDirectives(text, { projectValue: (key) => (key === 'building_class' ? 'GK 4' : null) })).toBe(
      'GK GK 4, FN escape_level_m, X nope.'
    )
  })

  it('knows the new blocks, and strips their fences', () => {
    for (const name of ['actions', 'not-found', 'subsumption']) expect(isDirectiveBlock(name)).toBe(true)
    expect(stripDirectives(':::not-found\n> „x" [1]\n:::')).toBe('> „x" [1]')
    expect(Object.keys(PROJECT_KEYS)).toEqual(['building_class', 'escape_level_m', 'use', 'state', 'storeys', 'gross_floor_area_m2'])
  })
})
