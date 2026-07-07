import { describe, test, expect, vi } from 'vitest'
import { getByPath, interpolate, createTranslator } from './translate'

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
