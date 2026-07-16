import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MIN_INTERVAL_MINUTES,
  isFiveFieldCron,
  isValidCronExpression,
  isValidTimezone,
  minIntervalMinutesFromEnv,
  nextOccurrence,
  validateCron,
} from './schedule'
import { BadRequestError } from '@/lib/api/errors'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isFiveFieldCron', () => {
  it('accepts exactly 5 fields, rejects 6-field (seconds) and malformed', () => {
    expect(isFiveFieldCron('0 9 * * 1')).toBe(true)
    expect(isFiveFieldCron('*/5 * * * *')).toBe(true)
    expect(isFiveFieldCron('0 0 9 * * 1')).toBe(false) // 6-field
    expect(isFiveFieldCron('0 9 * *')).toBe(false) // 4-field
  })
})

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('Europe/Vienna')).toBe(true)
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(isValidTimezone('Not/AZone')).toBe(false)
    expect(isValidTimezone('')).toBe(false)
  })
})

describe('isValidCronExpression', () => {
  it('accepts valid 5-field cron, rejects 6-field and invalid syntax', () => {
    expect(isValidCronExpression('0 9 * * 1')).toBe(true)
    expect(isValidCronExpression('0 0 9 * * 1')).toBe(false)
    expect(isValidCronExpression('99 * * * *')).toBe(false)
    expect(isValidCronExpression('not a cron')).toBe(false)
  })
})

describe('minIntervalMinutesFromEnv', () => {
  it('defaults to 15 and honours a positive override', () => {
    expect(minIntervalMinutesFromEnv()).toBe(DEFAULT_MIN_INTERVAL_MINUTES)
    vi.stubEnv('GRID_WORKFLOW_MIN_INTERVAL_MINUTES', '30')
    expect(minIntervalMinutesFromEnv()).toBe(30)
    vi.stubEnv('GRID_WORKFLOW_MIN_INTERVAL_MINUTES', '0')
    expect(minIntervalMinutesFromEnv()).toBe(DEFAULT_MIN_INTERVAL_MINUTES)
    vi.stubEnv('GRID_WORKFLOW_MIN_INTERVAL_MINUTES', 'nonsense')
    expect(minIntervalMinutesFromEnv()).toBe(DEFAULT_MIN_INTERVAL_MINUTES)
  })
})

describe('validateCron', () => {
  it('accepts an hourly schedule (60-min gap ≥ 15-min minimum)', () => {
    expect(() => validateCron('0 * * * *', 'UTC', 15)).not.toThrow()
  })

  it('accepts a weekly schedule with a timezone', () => {
    expect(() => validateCron('0 9 * * 1', 'Europe/Vienna', 15)).not.toThrow()
  })

  it('rejects a sub-minimum cadence (every 5 minutes < 15)', () => {
    expect(() => validateCron('*/5 * * * *', 'UTC', 15)).toThrow(BadRequestError)
  })

  it('rejects a 6-field expression', () => {
    expect(() => validateCron('0 0 9 * * 1', 'UTC', 15)).toThrow(BadRequestError)
  })

  it('rejects an invalid cron expression', () => {
    expect(() => validateCron('99 99 * * *', 'UTC', 15)).toThrow(BadRequestError)
  })

  it('rejects an unknown timezone', () => {
    expect(() => validateCron('0 9 * * 1', 'Not/AZone', 15)).toThrow(BadRequestError)
  })

  it('honours a custom (looser) minimum interval', () => {
    // Every 5 minutes is allowed when the minimum is 5.
    expect(() => validateCron('*/5 * * * *', 'UTC', 5)).not.toThrow()
  })
})

describe('nextOccurrence', () => {
  it('returns the next occurrence STRICTLY after the given instant', () => {
    const after = new Date('2026-07-16T08:00:00Z') // a Thursday
    const next = nextOccurrence('0 9 * * *', 'UTC', after)
    expect(next.toISOString()).toBe('2026-07-16T09:00:00.000Z')
    expect(next.getTime()).toBeGreaterThan(after.getTime())
  })

  it('excludes an instant that exactly matches an occurrence (strictly future)', () => {
    const exact = new Date('2026-07-16T09:00:00Z')
    const next = nextOccurrence('0 9 * * *', 'UTC', exact)
    expect(next.toISOString()).toBe('2026-07-17T09:00:00.000Z')
  })

  it('is DST-safe: 09:00 Europe/Vienna resolves to the correct UTC instant', () => {
    // Summer (CEST, UTC+2): 09:00 local Monday → 07:00 UTC.
    const summer = nextOccurrence('0 9 * * 1', 'Europe/Vienna', new Date('2026-07-16T00:00:00Z'))
    expect(summer.toISOString()).toBe('2026-07-20T07:00:00.000Z')
    // Winter (CET, UTC+1): 09:00 local Monday → 08:00 UTC.
    const winter = nextOccurrence('0 9 * * 1', 'Europe/Vienna', new Date('2026-01-01T00:00:00Z'))
    expect(winter.toISOString()).toBe('2026-01-05T08:00:00.000Z')
  })
})
