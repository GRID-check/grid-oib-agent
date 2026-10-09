import { describe, expect, test } from 'vitest'

import {
  isIsoDay,
  matchingPreset,
  parseQualityScopeStrict,
  presetRange,
  qualityScopeQuery,
  rangeDays,
  readQualityScope,
  scopeBounds,
} from './scope'

const NOW = new Date('2026-10-09T08:00:00Z')

describe('quality scope', () => {
  test('a preset is the last N days ending today, inclusive', () => {
    expect(presetRange(7, NOW)).toEqual({ from: '2026-10-03', to: '2026-10-09' })
    expect(rangeDays('2026-10-03', '2026-10-09')).toBe(7)
    expect(matchingPreset({ from: '2026-10-03', to: '2026-10-09' }, NOW)).toBe(7)
    expect(matchingPreset({ from: '2026-10-02', to: '2026-10-08' }, NOW)).toBeNull()
  })

  test('isIsoDay refuses impossible dates', () => {
    expect(isIsoDay('2026-02-29')).toBe(false)
    expect(isIsoDay('2028-02-29')).toBe(true)
    expect(isIsoDay('2026-1-5')).toBe(false)
  })

  test('the page reader falls back to 30 days and keeps the old days= links', () => {
    expect(readQualityScope(new URLSearchParams(''), NOW)).toMatchObject({
      from: '2026-09-10',
      to: '2026-10-09',
    })
    expect(readQualityScope(new URLSearchParams('days=90'), NOW).from).toBe('2026-07-12')
    expect(readQualityScope(new URLSearchParams('from=2026-10-09&to=2026-10-01'), NOW).from).toBe(
      '2026-09-10'
    )
  })

  test('organization and project lists are de-duplicated and trimmed', () => {
    const scope = readQualityScope(
      new URLSearchParams('org=a&org=%20a%20&org=b&project=p&project='),
      NOW
    )
    expect(scope.organizationIds).toEqual(['a', 'b'])
    expect(scope.projectIds).toEqual(['p'])
  })

  test('the API reader refuses a bad range instead of answering for another one', () => {
    expect(parseQualityScopeStrict(new URLSearchParams('from=2026-10-01&to=nope'), NOW)).toEqual({
      ok: false,
      error: 'invalid_to',
    })
    expect(
      parseQualityScopeStrict(new URLSearchParams('from=2026-10-09&to=2026-10-01'), NOW)
    ).toEqual({
      ok: false,
      error: 'range_inverted',
    })
    expect(
      parseQualityScopeStrict(new URLSearchParams('from=2024-01-01&to=2026-01-01'), NOW)
    ).toEqual({
      ok: false,
      error: 'range_too_long',
    })
    expect(parseQualityScopeStrict(new URLSearchParams('days=7'), NOW)).toMatchObject({ ok: true })
  })

  test('query string round-trips through the reader', () => {
    const scope = {
      from: '2026-09-01',
      to: '2026-09-30',
      organizationIds: ['o1', 'o2'],
      projectIds: ['p1'],
    }
    expect(readQualityScope(new URLSearchParams(qualityScopeQuery(scope)), NOW)).toEqual(scope)
  })

  test('bounds are UTC midnight, end exclusive', () => {
    const { start, endExclusive } = scopeBounds({ from: '2026-09-01', to: '2026-09-30' })
    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(endExclusive.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })
})
