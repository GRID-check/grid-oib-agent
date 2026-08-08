/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backoffWithJitter, createRetryLadder } from './backoff'

describe('backoffWithJitter', () => {
  it('grows exponentially before jitter is applied', () => {
    // random() === 1 yields the top of the window, i.e. the undithered delay.
    const top = (attempt: number) =>
      backoffWithJitter(attempt, { baseMs: 1_000, maxMs: 30_000, random: () => 1 })

    expect(top(0)).toBe(1_000)
    expect(top(1)).toBe(2_000)
    expect(top(2)).toBe(4_000)
    expect(top(3)).toBe(8_000)
  })

  it('caps at maxMs', () => {
    const top = (attempt: number) =>
      backoffWithJitter(attempt, { baseMs: 1_000, maxMs: 30_000, random: () => 1 })

    expect(top(5)).toBe(30_000)
    expect(top(50)).toBe(30_000)
  })

  it('spreads each wave across the back half of its window', () => {
    const attempt = 2 // undithered window is 4000ms
    const earliest = backoffWithJitter(attempt, {
      baseMs: 1_000,
      maxMs: 30_000,
      random: () => 0,
    })
    const latest = backoffWithJitter(attempt, {
      baseMs: 1_000,
      maxMs: 30_000,
      random: () => 1,
    })

    expect(earliest).toBe(2_000)
    expect(latest).toBe(4_000)
  })

  it('desynchronises clients that were dropped at the same instant', () => {
    // The regression this exists to prevent: without jitter every client
    // dropped by the same pod retries at an identical offset, so the herd
    // lands together on the surviving replicas.
    let seed = 0
    const clients = Array.from({ length: 50 }, () => {
      seed += 1 / 50
      return backoffWithJitter(3, {
        baseMs: 1_000,
        maxMs: 30_000,
        random: () => seed % 1,
      })
    })

    expect(new Set(clients).size).toBeGreaterThan(1)
    expect(Math.min(...clients)).toBeGreaterThanOrEqual(4_000)
    expect(Math.max(...clients)).toBeLessThanOrEqual(8_000)
  })

  it('never returns a negative or sub-window delay', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const delay = backoffWithJitter(attempt, { baseMs: 1_000, maxMs: 30_000 })
      const window = Math.min(30_000, 1_000 * 2 ** attempt)
      expect(delay).toBeGreaterThanOrEqual(window / 2)
      expect(delay).toBeLessThanOrEqual(window)
    }
  })

  it('treats negative attempts as attempt 0', () => {
    expect(
      backoffWithJitter(-5, { baseMs: 1_000, maxMs: 30_000, random: () => 1 })
    ).toBe(1_000)
  })
})

/**
 * The ladder exists because the function above is pure, so four call sites
 * hand-rolled the state around it — an attempt counter, a timer, a cancel, and a
 * rule for when the count goes back to zero. Every one of those four got the
 * RESET wrong at least once: a healthy tab resuming at the ceiling, a budget
 * spent by failures an hour apart, a timer outliving the effect that made it.
 * Those three are what is pinned hardest here. As a primitive they are
 * invariants, and an invariant is only worth the name if something checks it.
 */
describe('createRetryLadder', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('walks an explicit schedule and then refuses', () => {
    const ladder = createRetryLadder({ delaysMs: [100, 200] })
    const run = vi.fn()

    expect(ladder.schedule(run)).toBe(true)
    vi.advanceTimersByTime(100)
    expect(run).toHaveBeenCalledTimes(1)

    expect(ladder.schedule(run)).toBe(true)
    vi.advanceTimersByTime(200)
    expect(run).toHaveBeenCalledTimes(2)

    // Spent — and `schedule` SAYS so rather than silently doing nothing, because
    // every caller needs that moment to report a real failure.
    expect(ladder.spent).toBe(true)
    expect(ladder.schedule(run)).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('starts over on evidence that it works', () => {
    const ladder = createRetryLadder({ delaysMs: [100, 200] })
    const run = vi.fn()

    ladder.schedule(run)
    ladder.schedule(run)
    expect(ladder.spent).toBe(true)

    ladder.reset()

    expect(ladder.spent).toBe(false)
    expect(ladder.schedule(run)).toBe(true)
    vi.advanceTimersByTime(100)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('drops a pending retry on reset, so the rung it was on cannot still fire', () => {
    const ladder = createRetryLadder({ delaysMs: [100, 200] })
    const run = vi.fn()

    ladder.schedule(run)
    ladder.reset()
    vi.advanceTimersByTime(10_000)

    expect(run).not.toHaveBeenCalled()
  })

  it('cancels without forgiving — teardown is not vindication', () => {
    // What an unmount calls. It must not clear the count as well: the ladder is
    // being abandoned, not proven healthy.
    const ladder = createRetryLadder({ delaysMs: [100, 200] })
    const run = vi.fn()

    ladder.schedule(run)
    ladder.cancel()
    vi.advanceTimersByTime(10_000)
    expect(run).not.toHaveBeenCalled()

    ladder.schedule(run)
    // Rung two, not rung one: 100ms is no longer enough.
    vi.advanceTimersByTime(100)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps one retry in flight, however many failures arrive', () => {
    // Two errors in quick succession are one connection failing, not two.
    // Without the replace, both timers fire and the reconnect doubles.
    const ladder = createRetryLadder({ delaysMs: [100, 100, 100] })
    const run = vi.fn()

    ladder.schedule(run)
    ladder.schedule(run)
    vi.advanceTimersByTime(1_000)

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('bounds an exponential ladder by its budget', () => {
    const ladder = createRetryLadder({
      baseMs: 1_000,
      maxMs: 10_000,
      budget: 2,
      random: () => 1,
    })
    const run = vi.fn()

    expect(ladder.schedule(run)).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(ladder.schedule(run)).toBe(true)
    vi.advanceTimersByTime(2_000)
    expect(run).toHaveBeenCalledTimes(2)

    expect(ladder.schedule(run)).toBe(false)
  })

  it('never gives up without a budget', () => {
    // The shared event hub is this shape: giving up on the one connection that
    // carries every collaboration event is worse than waiting out the cap.
    const ladder = createRetryLadder({ baseMs: 1_000, maxMs: 2_000, random: () => 1 })
    const run = vi.fn()

    for (let round = 0; round < 50; round += 1) {
      expect(ladder.schedule(run)).toBe(true)
      vi.advanceTimersByTime(2_000)
    }

    expect(run).toHaveBeenCalledTimes(50)
    expect(ladder.spent).toBe(false)
  })
})
