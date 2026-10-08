import { describe, expect, it } from 'vitest'

import { matchCase, parseCaseClass, parseCaseRange, parseCases, rulerOf } from './cases'

describe('parseCaseRange', () => {
  it.each([
    ['bis 7 m', { min: null, max: 7 }],
    ['≤ 11 m', { min: null, max: 11 }],
    ['über 7 m bis 11 m', { min: 7, max: 11, minStrict: true }],
    ['7–11 m', { min: 7, max: 11 }],
    ['> 22 m', { min: 22, max: null, minStrict: true }],
    ['ab 22 m', { min: 22, max: null, minStrict: false }],
    ['Fluchtniveau bis 10,5 m', { min: null, max: 10.5 }],
  ])('%s', (text, expected) => {
    expect(parseCaseRange(text)).toMatchObject(expected)
  })

  it('is null for a case that states no bound', () => {
    expect(parseCaseRange('innen')).toBeNull()
    expect(parseCaseRange('GK 4')).toBeNull()
  })
})

describe('parseCases', () => {
  it('reads a run of „bis" rows as consecutive ranges', () => {
    const cases = parseCases('range', ['bis 7 m', 'bis 11 m', 'bis 22 m'])
    expect(cases).toEqual([
      { kind: 'range', min: null, max: 7, minStrict: false, maxStrict: false },
      { kind: 'range', min: 7, max: 11, minStrict: true, maxStrict: false },
      { kind: 'range', min: 11, max: 22, minStrict: true, maxStrict: false },
    ])
  })

  it('refuses a column one of whose cells is not a case', () => {
    expect(parseCases('range', ['bis 7 m', 'sonst'])).toBeNull()
    expect(parseCases('class', ['GK 3', 'Hochhaus'])).toBeNull()
  })

  it('reads classes in every spelling', () => {
    expect(['GK 3', 'GK4', 'Gebäudeklasse 5'].map(parseCaseClass)).toEqual([3, 4, 5])
  })
})

describe('matchCase', () => {
  const ranges = parseCases('range', ['bis 7 m', 'bis 11 m', 'bis 22 m']) ?? []

  it('finds the first case the value falls in; a threshold belongs to the case it closes', () => {
    expect(matchCase(ranges, { number: 10.8, text: null })).toBe(1)
    expect(matchCase(ranges, { number: 7, text: null })).toBe(0)
    expect(matchCase(ranges, { number: 30, text: null })).toBe(-1)
  })

  it('matches a class by number and a text by its words', () => {
    expect(matchCase(parseCases('class', ['GK 3', 'GK 4']) ?? [], { number: 4, text: 'GK 4' })).toBe(1)
    expect(matchCase(parseCases('text', ['Wien', 'Tirol']) ?? [], { number: null, text: 'Tirol' })).toBe(1)
    expect(matchCase(parseCases('text', ['Wohnen', 'Büro']) ?? [], { number: null, text: 'Büro, Wohnen' })).toBe(0)
  })
})

describe('rulerOf', () => {
  it('puts a tick at every threshold and says how far the next one is', () => {
    const cases = parseCases('range', ['bis 7 m', 'bis 11 m', 'bis 22 m']) ?? []
    const ruler = rulerOf(cases, ['GK 3', 'GK 4', 'GK 5'], 10.8)
    expect(ruler?.ticks.map((tick) => tick.value)).toEqual([7, 11, 22])
    expect(ruler?.segments.map((segment) => segment.holds)).toEqual([false, true, false])
    expect(ruler?.nearest).toMatchObject({ direction: 'below', label: 'GK 5' })
    expect(ruler?.nearest?.delta).toBeCloseTo(0.2)
    expect(ruler?.pin).toBeGreaterThan(ruler?.ticks[0].at ?? 0)
    expect(ruler?.pin).toBeLessThan(ruler?.ticks[1].at ?? 100)
  })

  it('is null for cases that are not a scale', () => {
    expect(rulerOf(parseCases('class', ['GK 3', 'GK 4']) ?? [], ['a', 'b'], 4)).toBeNull()
  })
})
