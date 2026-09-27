import { describe, expect, it } from 'vitest'
import { reuseEqualCards } from './reuse-equal-cards'
import { validateGridCards, type GridCard } from './schemas'

const WIRE = [
  { type: 'summary', title: 'Kurz', content: 'Inhalt', key_points: null },
  { type: 'legal_basis', law: 'OIB-Richtlinie 2', summary: 'Brandabschnitte.' },
]

describe('reuseEqualCards', () => {
  it('keeps the list and every card when a frame re-sends the same cards', () => {
    const prev = validateGridCards(WIRE)
    const next = validateGridCards(WIRE)
    expect(next[0]).not.toBe(prev[0])
    expect(reuseEqualCards(prev, next)).toBe(prev)
  })

  it('keeps the unchanged cards and takes the changed and the new ones', () => {
    const prev = validateGridCards(WIRE)
    const next = validateGridCards([
      WIRE[0],
      { ...WIRE[1], summary: 'Geändert.' },
      { type: 'callout', variant: 'hinweis', content: 'Neu.' },
    ])
    const merged = reuseEqualCards(prev, next)
    expect(merged).not.toBe(prev)
    expect(merged[0]).toBe(prev[0])
    expect(merged[1]).toBe(next[1])
    expect(merged[2]).toBe(next[2])
  })

  it('keeps a hole a hole, at its position', () => {
    const prev: (GridCard | undefined)[] = [undefined, ...validateGridCards([WIRE[1]])]
    const next: (GridCard | undefined)[] = [undefined, ...validateGridCards([WIRE[1]])]
    expect(reuseEqualCards(prev, next)).toBe(prev)
  })

  it('takes the new list when there was none', () => {
    const next = validateGridCards(WIRE)
    expect(reuseEqualCards(undefined, next)).toBe(next)
  })
})
