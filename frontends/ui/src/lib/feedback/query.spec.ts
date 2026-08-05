/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { parseFeedbackFilters } from './query'

const parse = (query: string) => parseFeedbackFilters(new URLSearchParams(query))

describe('parseFeedbackFilters', () => {
  it('takes the values it recognises', () => {
    expect(parse('days=7&verdict=up&reason=inaccurate&org=org_2&topic=brandschutz&q=fluchtweg')).toEqual({
      windowDays: 7,
      verdict: 'up',
      reason: 'inaccurate',
      organizationId: 'org_2',
      topic: 'brandschutz',
      query: 'fluchtweg',
    })
  })

  /**
   * `reason` and `topic` reach a SQL comparison, so neither may be anything the
   * server did not already know about. Coerced, never trusted.
   */
  it('drops a reason and a topic it does not know', () => {
    const filters = parse("reason=' or 1=1--&topic=nonsense")
    expect(filters.reason).toBeNull()
    expect(filters.topic).toBeNull()
  })

  /**
   * Anything but an explicit `up` is `down`. The failed answers are the
   * actionable list, so a malformed value must not land the reader in the praise
   * list wondering where the problems went.
   */
  it('defaults the direction to the failures', () => {
    expect(parse('').verdict).toBe('down')
    expect(parse('verdict=UP').verdict).toBe('down')
    expect(parse('verdict=sideways').verdict).toBe('down')
  })

  it('falls back to the default window for anything unoffered', () => {
    for (const query of ['', 'days=', 'days=abc', 'days=1', 'days=999']) {
      expect(parse(query).windowDays).toBe(30)
    }
  })

  it('bounds the free-text search — it becomes an ILIKE, not a novel', () => {
    expect(parse(`q=${'a'.repeat(500)}`).query).toHaveLength(120)
    // Whitespace-only is absence, not a search for spaces.
    expect(parse('q=%20%20').query).toBeNull()
  })
})
