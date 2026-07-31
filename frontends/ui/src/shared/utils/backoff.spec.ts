import { describe, expect, it } from 'vitest'
import { backoffWithJitter } from './backoff'

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
