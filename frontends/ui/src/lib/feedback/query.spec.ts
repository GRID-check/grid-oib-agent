/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { BadRequestError } from '@/lib/api/errors'
import { NO_RATINGS_FILTERS } from './filters'
import { parseFeedbackQuery, requireFeedbackQuery } from './query'

const NOW = new Date('2026-10-09T09:30:00.000Z')
const PROJECT = '0b6f2a1e-5c3d-4e8f-9a7b-1c2d3e4f5a61'

const parse = (query: string) => parseFeedbackQuery(new URLSearchParams(query), NOW)
const ok = (query: string) => {
  const parsed = parse(query)
  if (!parsed.ok) throw new Error(`refused ${query}: ${parsed.error} (${parsed.param})`)
  return parsed.query
}

describe('parseFeedbackQuery', () => {
  it('reads the scope and every ratings filter, repeatable ones as lists', () => {
    const query = ok(
      `from=2026-07-01&to=2026-09-30&org=org_a&org=org_b&project=${PROJECT}` +
        '&verdict=down&reason=wrong_source&reason=inaccurate&topic=statik&topic=brandschutz' +
        '&mode=report&mode=shallow&confidence=low&has_comment=1&has_expected=1&q=%20fluchtweg%20'
    )
    expect(query).toEqual({
      scope: { from: '2026-07-01', to: '2026-09-30', organizationIds: ['org_a', 'org_b'], projectIds: [PROJECT] },
      ratings: {
        verdict: 'down',
        // Canonical order, whatever order the URL had: one set, one cache key.
        reasons: ['inaccurate', 'wrong_source'],
        topics: ['brandschutz', 'statik'],
        modes: ['shallow', 'report'],
        confidences: ['low'],
        hasComment: true,
        hasExpectedAnswer: true,
        query: 'fluchtweg',
      },
    })
  })

  it('defaults to every vote of the last 30 days, both verdicts', () => {
    expect(ok('')).toEqual({
      scope: { from: '2026-09-10', to: '2026-10-09', organizationIds: [], projectIds: [] },
      ratings: NO_RATINGS_FILTERS,
    })
  })

  describe('refuses with the parameter named', () => {
    it.each([
      ['an unknown reason', "reason=' or 1=1--", 'reason'],
      ['an unknown topic', 'topic=nonsense', 'topic'],
      ['an unknown mode', 'mode=error', 'mode'],
      ['an unknown confidence', 'confidence=certain', 'confidence'],
      ['an unknown verdict', 'verdict=sideways', 'verdict'],
      ['a flag that is not 0 or 1', 'has_comment=yes', 'has_comment'],
      ['an unknown export scope', 'scope=everything', 'scope'],
      ['a project that is not a uuid', 'project=42', 'project'],
      ['a malformed start', 'from=2026-13-01&to=2026-10-01', 'from'],
      ['an inverted range', 'from=2026-10-02&to=2026-10-01', 'from'],
      ['a range over 366 days', 'from=2024-01-01&to=2026-01-01', 'from'],
      ['a reason with the helpful verdict', 'verdict=up&reason=inaccurate', 'reason'],
    ])('%s', (_name, query, param) => {
      const parsed = parse(query)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.param).toBe(param)
    })

    it('more than 200 organizations', () => {
      const many = Array.from({ length: 201 }, (_, i) => `org=o${i}`).join('&')
      expect(parse(many)).toMatchObject({ ok: false, error: 'too_many_values', param: 'org' })
    })

    it('as a 400 for a route', () => {
      expect(() => requireFeedbackQuery(new URLSearchParams('topic=nonsense'), NOW)).toThrow(BadRequestError)
    })
  })

  describe('older links', () => {
    it('reads `days` as a range ending today', () => {
      expect(ok('days=7').scope).toMatchObject({ from: '2026-10-03', to: '2026-10-09' })
    })

    /** The old drill-in export defaulted to the down-votes when no verdict was sent. */
    it('maps `scope=selection` to the filters, down-votes by default', () => {
      const query = ok('scope=selection&days=7&org=org_2&topic=brandschutz&reason=inaccurate&q=GK')
      expect(query.scope.organizationIds).toEqual(['org_2'])
      expect(query.ratings).toMatchObject({
        verdict: 'down',
        reasons: ['inaccurate'],
        topics: ['brandschutz'],
        query: 'GK',
      })
      expect(ok('scope=selection&verdict=up').ratings.verdict).toBe('up')
    })

    it('reads `scope=all` as every vote in the scope, rating filters ignored', () => {
      const query = ok('scope=all&org=org_2&verdict=down&reason=inaccurate&topic=statik')
      expect(query.scope.organizationIds).toEqual(['org_2'])
      expect(query.ratings).toEqual(NO_RATINGS_FILTERS)
    })

    it('takes `verdict=all` as both directions', () => {
      expect(ok('verdict=all').ratings.verdict).toBeNull()
    })
  })

  it('bounds the search', () => {
    expect(ok(`q=${'x'.repeat(500)}`).ratings.query).toHaveLength(120)
  })
})
