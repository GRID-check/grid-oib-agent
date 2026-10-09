import { describe, expect, it } from 'vitest'

import {
  activeRatingsFilterKeys,
  feedbackQueryString,
  NO_RATINGS_FILTERS,
  ratingsFiltered,
  readRatingsFilters,
  toggleValue,
  writeRatingsFilters,
  type RatingsFilters,
} from './filters'

const full: RatingsFilters = {
  verdict: 'down',
  reasons: ['inaccurate', 'other'],
  topics: ['brandschutz'],
  modes: ['deep'],
  confidences: ['high'],
  hasComment: true,
  hasExpectedAnswer: true,
  query: 'GK 4',
}

describe('the ratings filters in a URL', () => {
  it('round-trip through the page URL, other keys untouched', () => {
    const params = writeRatingsFilters(new URLSearchParams('view=ratings&from=2026-09-01'), full)
    expect(params.get('view')).toBe('ratings')
    expect(params.get('from')).toBe('2026-09-01')
    expect(readRatingsFilters(params)).toEqual(full)
  })

  it('writes nothing for no filters, and replaces what was there', () => {
    const params = writeRatingsFilters(new URLSearchParams('reason=inaccurate&q=x&view=ratings'), NO_RATINGS_FILTERS)
    expect(params.toString()).toBe('view=ratings')
  })

  /** The page URL is read leniently: a stale link opens a sensible view, not an error. */
  it('drops what it does not know when reading the page URL', () => {
    expect(readRatingsFilters(new URLSearchParams('verdict=maybe&reason=nope&topic=Brandschutz&mode=error'))).toEqual({
      ...NO_RATINGS_FILTERS,
      topics: ['brandschutz'],
    })
  })

  it('drops reasons under the helpful verdict: a reason exists only on a down-vote', () => {
    expect(readRatingsFilters(new URLSearchParams('verdict=up&reason=inaccurate')).reasons).toEqual([])
  })

  it('puts the scope first and the filters after it in the API query string', () => {
    const search = feedbackQueryString({
      scope: { from: '2026-09-01', to: '2026-09-30', organizationIds: ['org_a'], projectIds: [] },
      ratings: { ...NO_RATINGS_FILTERS, topics: ['statik', 'brandschutz'] },
    })
    expect(search).toBe('from=2026-09-01&to=2026-09-30&org=org_a&topic=brandschutz&topic=statik')
  })
})

describe('helpers', () => {
  it('know whether anything narrows, and what', () => {
    expect(ratingsFiltered(NO_RATINGS_FILTERS)).toBe(false)
    expect(ratingsFiltered({ ...NO_RATINGS_FILTERS, hasComment: true })).toBe(true)
    expect(activeRatingsFilterKeys(full)).toEqual([
      'verdict',
      'reasons',
      'topics',
      'modes',
      'confidences',
      'hasComment',
      'hasExpectedAnswer',
      'query',
    ])
  })

  it('toggle a value in a list', () => {
    expect(toggleValue(['a', 'b'], 'b')).toEqual(['a'])
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b'])
  })
})
