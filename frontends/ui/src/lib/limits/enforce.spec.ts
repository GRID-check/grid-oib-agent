/**
 * @vitest-environment node
 */
/**
 * Behaviour of the L2 limiter, exercised against REAL counting.
 *
 * These specs use the per-process store rather than a mock, so they test the
 * thing that actually runs: `rate-limiter-flexible`'s accounting, the two-clause
 * (sustained + burst) union, and the shape this module hands back. A mocked
 * store would only have proved that the mock returns what it was told to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooManyRequestsError } from '@/lib/api/errors'
import { consumeLimit, enforceLimit, rateLimitHeaders } from './enforce'
import { createInProcessStore, setLimitStore, type LimitStore } from './store'
import type { LimitRule } from './types'

/** Tight windows so the specs assert on counting, not on wall-clock waits. */
const SUSTAINED_ONLY: LimitRule = { name: 'spec-sustained', limit: 3, windowMs: 60_000 }
const WITH_BURST: LimitRule = {
  name: 'spec-burst',
  limit: 10,
  windowMs: 60_000,
  burst: { limit: 2, windowMs: 60_000 },
}

/** A fresh subject per test — buckets are keyed by it, so this isolates them. */
let subjectCounter = 0
const nextSubject = () => `subject-${++subjectCounter}`

beforeEach(() => {
  setLimitStore(createInProcessStore())
})

afterEach(() => {
  setLimitStore(null)
  vi.restoreAllMocks()
})

describe('consumeLimit', () => {
  it('allows calls up to the budget and refuses the one past it', async () => {
    const subject = nextSubject()

    for (let i = 0; i < SUSTAINED_ONLY.limit; i++) {
      const decision = await consumeLimit(SUSTAINED_ONLY, subject)
      expect(decision.allowed).toBe(true)
      expect(decision.degraded).toBe(false)
    }

    const refused = await consumeLimit(SUSTAINED_ONLY, subject)
    expect(refused.allowed).toBe(false)
    expect(refused.remaining).toBe(0)
    expect(refused.rule).toBe(SUSTAINED_ONLY.name)
  })

  it('reports a real retry time rather than the window length', async () => {
    const subject = nextSubject()
    for (let i = 0; i < SUSTAINED_ONLY.limit; i++) await consumeLimit(SUSTAINED_ONLY, subject)

    const refused = await consumeLimit(SUSTAINED_ONLY, subject)
    // The window is 60s; the wait is what remains of it, never more.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it('counts a multi-unit call as its full cost', async () => {
    const subject = nextSubject()

    // The whole budget in one call — mentioning three people at once.
    const first = await consumeLimit(SUSTAINED_ONLY, subject, SUSTAINED_ONLY.limit)
    expect(first.allowed).toBe(true)

    const refused = await consumeLimit(SUSTAINED_ONLY, subject)
    expect(refused.allowed).toBe(false)
  })

  it('keeps buckets separate per subject', async () => {
    const mine = nextSubject()
    const theirs = nextSubject()
    for (let i = 0; i < SUSTAINED_ONLY.limit; i++) await consumeLimit(SUSTAINED_ONLY, mine)

    expect((await consumeLimit(SUSTAINED_ONLY, mine)).allowed).toBe(false)
    // Exhausting one member's budget must not touch anybody else's.
    expect((await consumeLimit(SUSTAINED_ONLY, theirs)).allowed).toBe(true)
  })

  it('enforces the burst clause well before the sustained budget is spent', async () => {
    const subject = nextSubject()

    expect((await consumeLimit(WITH_BURST, subject)).allowed).toBe(true)
    expect((await consumeLimit(WITH_BURST, subject)).allowed).toBe(true)

    // Two allowed out of a sustained budget of ten: the short clause bit first,
    // which is the whole reason it exists.
    const refused = await consumeLimit(WITH_BURST, subject)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('fails OPEN and says so when the store is unavailable', async () => {
    const broken: LimitStore = {
      consume: () => Promise.reject(new Error('dragonfly is down')),
    }
    setLimitStore(broken)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const decision = await consumeLimit(SUSTAINED_ONLY, nextSubject())

    // An abuse bound must never be the thing that takes the product down...
    expect(decision.allowed).toBe(true)
    // ...but "we could not tell" must be distinguishable from "within budget",
    // or a broken limiter reports full health while enforcing nothing.
    expect(decision.degraded).toBe(true)
  })
})

describe('enforceLimit', () => {
  it('throws a 429 carrying the policy and the retry time', async () => {
    const subject = nextSubject()
    for (let i = 0; i < SUSTAINED_ONLY.limit; i++) await enforceLimit(SUSTAINED_ONLY, subject)

    const error = await enforceLimit(SUSTAINED_ONLY, subject).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(TooManyRequestsError)
    const rateLimited = error as TooManyRequestsError
    expect(rateLimited.status).toBe(429)
    expect(rateLimited.code).toBe('RATE_LIMITED')
    expect(rateLimited.retryAfterSeconds).toBeGreaterThan(0)
    expect(rateLimited.decision.rule).toBe(SUSTAINED_ONLY.name)
  })

  it('returns the decision without throwing while within budget', async () => {
    const decision = await enforceLimit(SUSTAINED_ONLY, nextSubject())
    expect(decision.allowed).toBe(true)
  })
})

describe('rateLimitHeaders', () => {
  it('advertises remaining budget on an allowed decision and no Retry-After', async () => {
    const headers = rateLimitHeaders(await consumeLimit(SUSTAINED_ONLY, nextSubject()))

    expect(headers['X-RateLimit-Limit']).toBe(String(SUSTAINED_ONLY.limit))
    expect(headers['X-RateLimit-Policy']).toBe(SUSTAINED_ONLY.name)
    expect(headers['Retry-After']).toBeUndefined()
  })

  it('carries Retry-After on a refusal, never below one second', async () => {
    const subject = nextSubject()
    for (let i = 0; i < SUSTAINED_ONLY.limit; i++) await consumeLimit(SUSTAINED_ONLY, subject)

    const headers = rateLimitHeaders(await consumeLimit(SUSTAINED_ONLY, subject))

    // A `Retry-After: 0` invites an immediate retry, which is exactly the
    // storm the refusal is trying to stop.
    expect(Number(headers['Retry-After'])).toBeGreaterThanOrEqual(1)
  })
})
