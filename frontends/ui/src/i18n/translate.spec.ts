/**
 * @vitest-environment node
 */
import { describe, test, expect, vi } from 'vitest'
import { getByPath, interpolate, createTranslator } from './translate'
import { dictionaries } from './dictionaries'

/**
 * Every plural block in every dictionary speaks the cut-down syntax the
 * translator reads: `one` and `other`, nothing else. A label it does not know
 * (`=0`, `zero`, `few`) ends the branch scan, and the whole block renders as an
 * empty string: „Durchsucht wurden dieses Projekt, und die Büroablage."
 * shipped from a `=0` branch until this held it.
 */
describe('plural blocks in the dictionaries', () => {
  const strings = (node: unknown, path: string, found: Array<[string, string]>): Array<[string, string]> => {
    if (typeof node === 'string') found.push([path, node])
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) strings(value, path ? `${path}.${key}` : key, found)
    }
    return found
  }

  /** The branch labels of each plural block in `template`. */
  const labelsOf = (template: string): string[][] =>
    [...template.matchAll(/\{\w+,\s*plural,\s*/g)].map((header) => {
      const labels: string[] = []
      let depth = 1
      let label = ''
      for (let cursor = (header.index ?? 0) + header[0].length; cursor < template.length && depth > 0; cursor += 1) {
        const char = template[cursor]
        if (char === '{') {
          if (depth === 1) labels.push(label.trim())
          depth += 1
          label = ''
        } else if (char === '}') depth -= 1
        else if (depth === 1) label += char
      }
      return labels
    })

  const malformed = (labels: string[]): boolean =>
    !labels.includes('other') || labels.some((label) => label !== 'one' && label !== 'other')

  test.each(Object.entries(dictionaries))('%s: only `one` and `other`, and always `other`', (_locale, dictionary) => {
    const offenders = strings(dictionary, '', [])
      .filter(([, text]) => labelsOf(text).some(malformed))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  test('the check sees a branch the translator cannot read', () => {
    expect(labelsOf('{count, plural, =0 {keins} one {# Projekt} other {# Projekte}}').some(malformed)).toBe(true)
    expect(labelsOf('{count, plural, one {# Projekt} other {# Projekte}}').some(malformed)).toBe(false)
  })
})

describe('getByPath', () => {
  const obj = { a: { b: { c: 'deep' } }, x: 'top' }

  test('reads a nested dot path', () => {
    expect(getByPath(obj, 'a.b.c')).toBe('deep')
  })

  test('reads a top-level key', () => {
    expect(getByPath(obj, 'x')).toBe('top')
  })

  test('returns undefined for a missing path', () => {
    expect(getByPath(obj, 'a.b.z')).toBeUndefined()
    expect(getByPath(obj, 'nope')).toBeUndefined()
  })

  test('returns undefined when descending through a non-object', () => {
    expect(getByPath(obj, 'x.y')).toBeUndefined()
  })
})

describe('interpolate', () => {
  test('replaces named placeholders', () => {
    expect(interpolate('Hello {name}', { name: 'Ada' })).toBe('Hello Ada')
  })

  test('replaces multiple and repeated placeholders', () => {
    expect(interpolate('{a}-{b}-{a}', { a: '1', b: '2' })).toBe('1-2-1')
  })

  test('coerces numbers to strings', () => {
    expect(interpolate('{n} items', { n: 3 })).toBe('3 items')
  })

  test('leaves unknown placeholders untouched', () => {
    expect(interpolate('Hi {missing}', { name: 'x' })).toBe('Hi {missing}')
  })

  test('returns the template unchanged when no vars given', () => {
    expect(interpolate('plain text')).toBe('plain text')
  })
})

describe('interpolate plural blocks', () => {
  const steps = '{count, plural, one {# Schritt} other {# Schritte}}'

  test('picks the singular at exactly one', () => {
    expect(interpolate(steps, { count: 1 })).toBe('1 Schritt')
  })

  test('picks the plural above one', () => {
    expect(interpolate(steps, { count: 2 })).toBe('2 Schritte')
    expect(interpolate(steps, { count: 17 })).toBe('17 Schritte')
  })

  test('picks the plural at zero, as German and English both do', () => {
    expect(interpolate(steps, { count: 0 })).toBe('0 Schritte')
  })

  test('resolves a block sitting inside a longer sentence', () => {
    expect(
      interpolate('Piloti hat sich {count, plural, one {# Notiz} other {# Notizen}} gemerkt', {
        count: 1,
      })
    ).toBe('Piloti hat sich 1 Notiz gemerkt')
  })

  test('interpolates ordinary placeholders inside a branch', () => {
    const template = '{count, plural, one {# Treffer für „{query}“} other {# Treffer für „{query}“}}'
    expect(interpolate(template, { count: 1, query: 'OIB 6' })).toBe('1 Treffer für „OIB 6“')
  })

  test('resolves several blocks in one template', () => {
    const template =
      '{hits, plural, one {# hit} other {# hits}} in {docs, plural, one {# document} other {# documents}}'
    expect(interpolate(template, { hits: 1, docs: 1 })).toBe('1 hit in 1 document')
    expect(interpolate(template, { hits: 4, docs: 2 })).toBe('4 hits in 2 documents')
  })

  test('falls to the plural branch when the count is missing or not a number', () => {
    expect(interpolate(steps, { other: 1 })).toBe(' Schritte')
    expect(interpolate(steps, { count: 'viele' })).toBe('viele Schritte')
  })

  test('leaves an ordinary placeholder alone next to a block', () => {
    expect(
      interpolate('{name}: {count, plural, one {# Seite} other {# Seiten}}', {
        name: 'OIB 6',
        count: 1,
      })
    ).toBe('OIB 6: 1 Seite')
  })

  test('leaves a template without a block untouched', () => {
    expect(interpolate('{count} Treffer', { count: 1 })).toBe('1 Treffer')
  })
})

describe('createTranslator', () => {
  const dict = {
    common: { hello: 'Hello', greet: 'Hi {name}' },
    nested: { deep: { value: 'Deep' } },
  }

  test('resolves an unscoped key', () => {
    const t = createTranslator(dict)
    expect(t('common.hello')).toBe('Hello')
  })

  test('resolves a namespaced key', () => {
    const t = createTranslator(dict, 'common')
    expect(t('hello')).toBe('Hello')
    expect(t('greet', { name: 'Bo' })).toBe('Hi Bo')
  })

  test('returns the full key for a missing translation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = createTranslator(dict, 'common')
    expect(t('does.not.exist')).toBe('common.does.not.exist')
    warn.mockRestore()
  })

  test('returns the key when the path resolves to a non-string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = createTranslator(dict)
    expect(t('nested.deep')).toBe('nested.deep')
    warn.mockRestore()
  })
})
