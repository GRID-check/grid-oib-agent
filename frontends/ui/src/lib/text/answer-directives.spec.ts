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

describe('normalizeDirectiveFences: repairs, so no `:::` reaches the page', () => {
  it('outlasts a line of colons inside a code block the block holds', () => {
    const text = ':::check\n```text\n:::\n```\n| A | Status |\n|---|---|\n| x | offen |\n:::\n\nDanach.'
    expect(normalizeDirectiveFences(text)).toBe(
      '::::check\n```text\n:::\n```\n| A | Status |\n|---|---|\n| x | offen |\n::::\n\nDanach.'
    )
  })

  it('repairs a space after the colons and free words after the name', () => {
    expect(normalizeDirectiveFences('::: check\n| a |\n:::')).toBe(':::check\n| a |\n:::')
    expect(normalizeDirectiveFences(':::check Brandschutz\n| a |\n:::')).toBe(':::check[Brandschutz]\n| a |\n:::')
  })

  it('drops a closer with nothing open, which after a table became a row', () => {
    expect(normalizeDirectiveFences('| a |\n|---|\n| b |\n:::')).toBe('| a |\n|---|\n| b |\n')
  })

  it('unwraps blocks nested past the depth bound, keeping their content', () => {
    const depth = 8
    const lines = [
      ...Array.from({ length: depth }, (_, at) => `${' '.repeat(at)}:::details[x${at}]`),
      'Inhalt',
      ...Array.from({ length: depth }, (_, at) => `${' '.repeat(depth - 1 - at)}:::`),
    ]
    const out = normalizeDirectiveFences(lines.join('\n')).split('\n')
    expect(out.filter((line) => /^\s*:{3,}details/.test(line))).toHaveLength(4)
    expect(out).toContain('Inhalt')
    expect(Math.max(...out.map((line) => /^\s*(:+)/.exec(line)?.[1].length ?? 0))).toBe(6)
  })

  it('reads a backtick line with a backtick after it as inline code, not a fence', () => {
    const text = '```a``` inline\n\n:::check\n| a |\n:::'
    expect(directiveDepths(text.split('\n'))).toEqual([0, 0, 0, 1, 1])
    expect(stripDirectives(text)).not.toContain(':::')
  })
})

describe('stripDirectives: the status a check prints is the one the page draws', () => {
  it('prints the computed outcome over an open word, and a contradiction with the word written', () => {
    const check = [
      ':::check',
      '| Anforderung | Ist | Soll | Status |',
      '|---|---|---|---|',
      '| Brandabschnitt | 1.380 m² | max. 1.200 m² | erfüllt [2] |',
      '| Trittschall | 57 dB | ≥ 55 dB | offen |',
      '| Aufzug | — | — | nicht anwendbar |',
      ':::',
    ].join('\n')
    expect(stripDirectives(check).split('\n')).toEqual([
      '| Anforderung | Ist | Soll | Status |',
      '|---|---|---|---|',
      '| Brandabschnitt | 1.380 m² | max. 1.200 m² | Widerspruch – prüfen (erfüllt) [2] |',
      '| Trittschall | 57 dB | ≥ 55 dB | erfüllt |',
      '| Aufzug | — | — | nicht anwendbar |',
    ])
  })

  it('reconciles a metrics table, and leaves a plain table outside a block alone', () => {
    const metrics = ':::metrics\n| Kennzahl | Wert | Grenzwert | Status |\n|---|---|---|---|\n| Stellplätze | 12 | mind. 14 | erfüllt |\n:::'
    expect(stripDirectives(metrics)).toContain('| Stellplätze | 12 | mind. 14 | Widerspruch – prüfen (erfüllt) |')
    const plain = '| A | Ist | Soll | Status |\n|---|---|---|---|\n| x | 1 m | ≥ 2 m | erfüllt |'
    expect(stripDirectives(plain)).toBe(plain)
  })
})

describe('stripDirectives: a slipped opener', () => {
  it('prints free words after the name as the label', () => {
    expect(stripDirectives(':::check Brandschutz\n| a |\n:::')).toBe('**Brandschutz**\n\n| a |')
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
