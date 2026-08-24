/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { nextOccurrence } from './cron.js'

describe('nextOccurrence', () => {
  it('returns a Date strictly after `after` for a simple daily schedule', () => {
    const after = new Date('2026-07-16T08:30:00Z')
    const next = nextOccurrence('0 9 * * *', 'UTC', after)
    expect(next).toBeInstanceOf(Date)
    expect(next.getTime()).toBeGreaterThan(after.getTime())
    expect(next.toISOString()).toBe('2026-07-16T09:00:00.000Z')
  })

  it('skips the current occurrence when `after` sits exactly on a firing time (strictly future)', () => {
    // 09:00 UTC is a firing time; passing it as `after` must yield the NEXT day,
    // never the same instant — otherwise the just-fired occurrence re-fires.
    const onOccurrence = new Date('2026-07-16T09:00:00Z')
    const next = nextOccurrence('0 9 * * *', 'UTC', onOccurrence)
    expect(next.getTime()).toBeGreaterThan(onOccurrence.getTime())
    expect(next.toISOString()).toBe('2026-07-17T09:00:00.000Z')
  })

  it('honours a per-schedule IANA timezone', () => {
    // 09:00 America/New_York on Mon 2026-07-20 (EDT, UTC-4) = 13:00 UTC.
    const after = new Date('2026-07-16T12:00:00Z')
    const next = nextOccurrence('0 9 * * 1', 'America/New_York', after)
    expect(next.toISOString()).toBe('2026-07-20T13:00:00.000Z')
  })

  it('defaults to UTC when no timezone is given', () => {
    const after = new Date('2026-07-16T08:30:00Z')
    const withUtc = nextOccurrence('0 9 * * *', 'UTC', after)
    const withDefault = nextOccurrence('0 9 * * *', undefined, after)
    expect(withDefault.toISOString()).toBe(withUtc.toISOString())
  })

  it('handles a spring-forward DST boundary via the library', () => {
    // US spring-forward 2026: 02:00 -> 03:00 local on Sun 2026-03-08. A 09:00
    // daily schedule in America/New_York straddles the transition: the day
    // before is EST (UTC-5 -> 14:00 UTC), the day of/after is EDT (UTC-4 ->
    // 13:00 UTC). Asking just after the pre-DST fire must yield the post-DST
    // fire at the correct, shifted UTC instant.
    const afterSat = new Date('2026-03-07T14:00:01Z') // just after Sat 09:00 EST
    const next = nextOccurrence('0 9 * * *', 'America/New_York', afterSat)
    expect(next.toISOString()).toBe('2026-03-08T13:00:00.000Z') // Sun 09:00 EDT
  })

  it('throws on an unparseable expression', () => {
    const after = new Date('2026-07-16T08:30:00Z')
    expect(() => nextOccurrence('not a cron', 'UTC', after)).toThrow()
  })
})
