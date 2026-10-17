import { describe, expect, it } from 'vitest'
import { exclusionsByTerm, nameStopMatchesOf } from './name-stop'

describe('exclusionsByTerm', () => {
  it('counts each stopped file once, by the term that caught it first, in order of first appearance', () => {
    expect(
      exclusionsByTerm([
        [{ term: 'Rechnung', segment: 'Schlussrechnung.pdf', kind: 'file' }],
        [
          { term: 'Personal', segment: 'Personal', kind: 'folder' },
          { term: 'Rechnung', segment: 'Rechnung_03.pdf', kind: 'file' },
        ],
        [{ term: 'Rechnung', segment: 'Rechnungen', kind: 'folder' }],
        [],
      ])
    ).toEqual([
      { term: 'Rechnung', count: 2 },
      { term: 'Personal', count: 1 },
    ])
  })
})

describe('nameStopMatchesOf', () => {
  it('reads the matches of the server’s 422', () => {
    expect(
      nameStopMatchesOf({
        error: 'excluded',
        code: 'UPLOAD_SCREENED',
        details: { matches: [{ term: 'Personal', segment: 'Personalakt', kind: 'folder' }] },
      })
    ).toEqual([{ term: 'Personal', segment: 'Personalakt', kind: 'folder' }])
  })

  it('drops a match it cannot read, and still calls the body a stop', () => {
    expect(
      nameStopMatchesOf({ code: 'UPLOAD_SCREENED', details: { matches: [{ term: 'X', kind: 'nonsense' }, 'junk'] } })
    ).toEqual([])
    expect(nameStopMatchesOf({ code: 'UPLOAD_SCREENED' })).toEqual([])
  })

  it('is null for any other body', () => {
    expect(nameStopMatchesOf({ code: 'CONFLICT', details: { matches: [] } })).toBeNull()
    expect(nameStopMatchesOf(null)).toBeNull()
    expect(nameStopMatchesOf('UPLOAD_SCREENED')).toBeNull()
  })
})
