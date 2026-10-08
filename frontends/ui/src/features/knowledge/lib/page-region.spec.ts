import { describe, expect, it } from 'vitest'
import { MAX_PAGE_REGIONS, mergePageRegions, parsePageRegions } from './page-region'

describe('parsePageRegions', () => {
  it('keeps a well-formed box and its label', () => {
    expect(parsePageRegions([{ box: [0.1, 0.2, 0.5, 0.6], label: ' Grundriss EG ' }])).toEqual([
      { box: [0.1, 0.2, 0.5, 0.6], label: 'Grundriss EG' },
    ])
  })

  it('drops what it cannot draw where it belongs, rather than repairing it', () => {
    expect(
      parsePageRegions([
        { box: [0.1, 0.2, 0.5] },
        { box: [0.5, 0.2, 0.1, 0.6] },
        { box: [0.1, 0.2, 1.4, 0.6] },
        { box: ['0.1', 0.2, 0.5, 0.6] },
        null,
        { box: [0, 0, 1, 1], label: 42 },
      ]),
    ).toEqual([{ box: [0, 0, 1, 1] }])
  })

  it('reads a source without regions as having none', () => {
    expect(parsePageRegions(undefined)).toBeUndefined()
    expect(parsePageRegions([])).toBeUndefined()
    expect(parsePageRegions([{ box: 'no' }])).toBeUndefined()
  })

  it('holds the cap', () => {
    const many = Array.from({ length: MAX_PAGE_REGIONS + 3 }, (_, index) => ({
      box: [index / 20, 0, index / 20 + 0.01, 0.1],
    }))
    expect(parsePageRegions(many)).toHaveLength(MAX_PAGE_REGIONS)
  })
})

describe('mergePageRegions', () => {
  it('folds one page’s boxes together without repeating one', () => {
    const grundriss = { box: [0.1, 0.2, 0.5, 0.6] as [number, number, number, number] }
    const schnitt = { box: [0.55, 0.2, 0.9, 0.6] as [number, number, number, number] }
    expect(mergePageRegions([grundriss], [{ ...grundriss }, schnitt])).toEqual([grundriss, schnitt])
    expect(mergePageRegions(undefined, undefined)).toBeUndefined()
    expect(mergePageRegions([grundriss], undefined)).toEqual([grundriss])
  })
})
