/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { resumableSessionId, RESUME_WINDOW_MS, type ResumableSession } from './resume-session'

const NOW = new Date('2026-07-28T14:00:00Z').getTime()
const minutesAgo = (m: number) => new Date(NOW - m * 60_000)

const session = (over: Partial<ResumableSession> & { id: string }): ResumableSession => ({
  updatedAt: minutesAgo(5),
  messages: [{}],
  ...over,
})

describe('resumableSessionId', () => {
  test('resumes a session touched moments ago — the reloaded-tab case', () => {
    expect(resumableSessionId([session({ id: 'a', updatedAt: minutesAgo(2) })], NOW)).toBe('a')
  })

  test('never reaches past a newer session', () => {
    const id = resumableSessionId(
      [
        session({ id: 'older', updatedAt: minutesAgo(120) }),
        session({ id: 'newest', updatedAt: minutesAgo(3) }),
        session({ id: 'middle', updatedAt: minutesAgo(40) }),
      ],
      NOW
    )
    expect(id).toBe('newest')
  })

  test('starts fresh once the newest session is older than the window', () => {
    const justOutside = new Date(NOW - RESUME_WINDOW_MS - 1000)
    expect(resumableSessionId([session({ id: 'a', updatedAt: justOutside })], NOW)).toBeNull()
  })

  test('the window boundary itself still resumes', () => {
    const exactly = new Date(NOW - RESUME_WINDOW_MS)
    expect(resumableSessionId([session({ id: 'a', updatedAt: exactly })], NOW)).toBe('a')
  })

  test('a stale newest session blocks resume even when an older one is recent', () => {
    // Rule 1 is absolute: we resume the newest or nothing. Reaching past it
    // would open a session the user did not touch last.
    const id = resumableSessionId(
      [
        session({ id: 'stale-newest', updatedAt: new Date(NOW - RESUME_WINDOW_MS - 60_000) }),
        session({ id: 'ancient', updatedAt: new Date(NOW - 5 * RESUME_WINDOW_MS) }),
      ],
      NOW
    )
    expect(id).toBeNull()
  })

  test('an empty session is not worth resuming — it equals a fresh start', () => {
    expect(resumableSessionId([session({ id: 'a', messages: [] })], NOW)).toBeNull()
  })

  test('no sessions at all → fresh start', () => {
    expect(resumableSessionId([], NOW)).toBeNull()
  })

  test('accepts serialized timestamps from storage, not just Date objects', () => {
    const iso = minutesAgo(10).toISOString()
    expect(resumableSessionId([session({ id: 'a', updatedAt: iso })], NOW)).toBe('a')
    expect(resumableSessionId([session({ id: 'a', updatedAt: minutesAgo(10).getTime() })], NOW)).toBe('a')
  })

  test('an unparseable timestamp never wins the newest slot', () => {
    const id = resumableSessionId(
      [session({ id: 'broken', updatedAt: 'not-a-date' }), session({ id: 'good', updatedAt: minutesAgo(1) })],
      NOW
    )
    expect(id).toBe('good')
  })

  test('a single unparseable session starts fresh rather than throwing', () => {
    expect(resumableSessionId([session({ id: 'broken', updatedAt: 'nonsense' })], NOW)).toBeNull()
  })

  test('clock skew (a future timestamp) resumes instead of reading as ancient', () => {
    expect(resumableSessionId([session({ id: 'a', updatedAt: new Date(NOW + 60_000) })], NOW)).toBe('a')
  })
})
