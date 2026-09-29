/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { emailDefaultFor, emailDueAt, isEmailDue, type InboxEmailCandidate } from './delivery'

const T0 = new Date('2026-09-29T08:00:00Z')

function row(overrides: Partial<InboxEmailCandidate> = {}): InboxEmailCandidate {
  return {
    type: 'mention.requested',
    updatedAt: T0,
    readAt: null,
    archivedAt: null,
    resolvedAt: null,
    inertAt: null,
    ...overrides,
  }
}

const minutes = (n: number) => new Date(T0.getTime() + n * 60_000)

describe('emailDueAt', () => {
  it('is the last activity plus the type delay', () => {
    // mention.requested waits an hour for the in-app read.
    expect(emailDueAt(row())).toEqual(minutes(60))
  })

  it('is immediate for a type whose delay is zero', () => {
    expect(emailDueAt(row({ type: 'feedback.submitted' }))).toEqual(T0)
  })

  it('is never for an in-app-only type', () => {
    expect(emailDueAt(row({ type: 'conversation.activity' }))).toBeNull()
  })

  it('treats a type this build does not know as in-app only', () => {
    // `type` is a text column; a newer deploy can write a value unknown here.
    expect(emailDefaultFor('something.from_the_future')).toEqual({ send: 'never' })
    expect(emailDueAt(row({ type: 'something.from_the_future' as InboxEmailCandidate['type'] }))).toBeNull()
  })
})

describe('isEmailDue — a reminder, not a copy', () => {
  it('is not due before the delay has passed', () => {
    expect(isEmailDue(row(), minutes(59))).toBe(false)
  })

  it('is due once the delay has passed and nothing has happened', () => {
    expect(isEmailDue(row(), minutes(60))).toBe(true)
  })

  it.each([
    ['read', { readAt: minutes(5) }],
    ['archived', { archivedAt: minutes(5) }],
    ['resolved', { resolvedAt: minutes(5) }],
    ['inert', { inertAt: minutes(5) }],
  ] as const)('is cancelled when the row was %s in the app first', (_label, change) => {
    expect(isEmailDue(row(change), minutes(120))).toBe(false)
  })
})
