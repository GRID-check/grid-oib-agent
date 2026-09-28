import { describe, expect, it } from 'vitest'

import { isNotRegulated, searchedSources } from './answer-data'

describe('searchedSources', () => {
  it('lists each document the rounds reached once, in the order first reached', () => {
    expect(
      searchedSources([
        {
          index: 1,
          key: 'a',
          tools: [],
          corpora: [],
          docs: [
            { name: 'oib.pdf', title: 'OIB-RL 2', detail: 'S. 4' },
            { name: 'OIB.pdf', title: 'OIB-RL 2', detail: 'S. 9' },
          ],
          newDocs: [],
          hits: 2,
          documents: 1,
        },
        { index: 2, key: 'b', tools: [], corpora: [], docs: [{ name: 'bo-wien.pdf' }], newDocs: [], hits: 1, documents: 1 },
      ])
    ).toEqual([{ title: 'OIB-RL 2', detail: 'S. 4' }, { title: 'bo-wien.pdf' }])
    expect(searchedSources(undefined)).toEqual([])
  })
})

describe('isNotRegulated', () => {
  it('reads the verdict, and says nothing for an answer without an envelope', () => {
    expect(isNotRegulated({ v: 2, kind: 'ruling', verdict: { value: 'Nicht geregelt', subject: 'PV' } })).toBe(true)
    expect(isNotRegulated({ v: 2, kind: 'ruling', verdict: { value: 'REI 90', subject: 'Wand' } })).toBe(false)
    expect(isNotRegulated(undefined)).toBeUndefined()
  })
})
