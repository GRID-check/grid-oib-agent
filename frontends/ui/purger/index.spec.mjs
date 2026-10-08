/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPurger } from './index.js'
import { createFailureStreak, escalationTicks } from '../workers/failure-streak.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The purger's default 60 s poll: five ticks is five minutes. */
const ESCALATE_AFTER = escalationTicks(60000)

/** A `postgres` client whose every transaction fails the way a restart does (#802, #803). */
function unreachable(code = 'EHOSTUNREACH') {
  const down = Object.assign(new Error(`connect ${code} 10.111.223.83:5432 - Local (0.0.0.0:0)`), { code })
  return { begin: vi.fn().mockRejectedValue(down) }
}

/** A reachable database with an empty queue: the reap and the claim both find nothing. */
function reachable() {
  const tx = Object.assign(() => Promise.resolve([]), { unsafe: () => Promise.resolve([]) })
  return { begin: vi.fn((cb) => cb(tx)) }
}

function purgerOver(sql, streak) {
  // The deps are never reached: no row is ever claimed.
  return createPurger({ sql, deps: /** @type {never} */ ({}), streak })
}

function spies() {
  return {
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  }
}

describe('purger tick during a database outage', () => {
  it('logs an unreachable database at WARN, once per tick, not the reap and the claim at ERROR', async () => {
    const { error, warn } = spies()
    const streak = createFailureStreak({ label: '[purger] queue', escalateAfter: ESCALATE_AFTER })

    await purgerOver(unreachable(), streak).tick()

    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[purger] queue failed (database unavailable (EHOSTUNREACH))')
  })

  it('escalates to ONE error after five failed ticks, and logs the recovery', async () => {
    const { error, log } = spies()
    const streak = createFailureStreak({ label: '[purger] queue', escalateAfter: ESCALATE_AFTER })
    const down = purgerOver(unreachable('57P03'), streak)

    for (let i = 0; i < 4; i += 1) await down.tick()
    expect(error).not.toHaveBeenCalled()
    for (let i = 0; i < 4; i += 1) await down.tick()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toBe(
      '[purger] queue still failing after 5 consecutive ticks: database unavailable (57P03)',
    )

    await purgerOver(reachable(), streak).tick()
    expect(log).toHaveBeenCalledWith('[purger] queue recovered after 8 failed ticks')
    expect(streak.count()).toBe(0)
  })

  it('keeps a claim that failed for any other reason at ERROR', async () => {
    const { error } = spies()
    const missing = Object.assign(new Error('function grid_legal_hold_blocks does not exist'), { code: '42883' })
    const sql = { begin: vi.fn().mockRejectedValue(missing) }

    await purgerOver(sql, createFailureStreak({ label: '[purger] queue', escalateAfter: ESCALATE_AFTER })).tick()

    expect(error.mock.calls.map(([line]) => line)).toEqual([
      '[purger] failed to reap stranded rows:',
      '[purger] tick failed, retrying on the next poll:',
    ])
  })
})
