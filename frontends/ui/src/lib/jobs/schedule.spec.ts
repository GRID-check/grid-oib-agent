/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BadRequestError } from '@/lib/api/errors'
import {
  DEFAULT_MIN_INTERVAL_MINUTES,
  isFiveFieldCron,
  isValidCronExpression,
  isValidTimezone,
  minIntervalMinutesFromEnv,
  nextOccurrence,
  validateCron,
} from './schedule'

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
    vi.stubEnv('GRID_SKILL_MIN_INTERVAL_MINUTES', '30')
    expect(minIntervalMinutesFromEnv()).toBe(30)
    vi.stubEnv('GRID_SKILL_MIN_INTERVAL_MINUTES', 'abc')
    expect(minIntervalMinutesFromEnv()).toBe(DEFAULT_MIN_INTERVAL_MINUTES)
  })
})

describe('nextOccurrence', () => {
  it('returns the next occurrence strictly after the reference', () => {
    const after = new Date('2025-01-01T00:00:00Z')
    const next = nextOccurrence('0 9 * * *', 'UTC', after)
    expect(next.getTime()).toBeGreaterThan(after.getTime())
    expect(next.toISOString()).toBe('2025-01-01T09:00:00.000Z')
  })
})

describe('validateCron', () => {
  it('accepts a valid cron and rejects shape/timezone/parse/min-interval failures', () => {
    expect(() => validateCron('0 9 * * 1', 'UTC')).not.toThrow()
    expect(() => validateCron('0 9 * *', 'UTC')).toThrow(BadRequestError)
    expect(() => validateCron('0 9 * * 1', 'Not/AZone')).toThrow(BadRequestError)
    expect(() => validateCron('99 * * * *', 'UTC')).toThrow(BadRequestError)
    expect(() => validateCron('*/1 * * * *', 'UTC', 15)).toThrow(BadRequestError)
  })
})
