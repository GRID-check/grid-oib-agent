/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  claimNext,
  markFailed,
  markFailedPermanent,
  markPurged,
  reapStranded,
  releaseHeld,
  MAX_ATTEMPTS,
} from './db.js'

// The db.js helpers take a postgres.js tagged-template function (`sql`/`tx`).
// We fake it the same way purge-project.spec.mjs does: record the rendered SQL
// text + bound values, and return configurable rows. `join('$')` renders each
// interpolation as a `$` placeholder; the interpolated values land, in order,
// in the `values` array — so we assert on both the SQL shape and the bindings.
function makeSql(returnRows = []) {
  const executed = []
  const fn = (strings, ...values) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    executed.push({ text, values })
    // SELECT and `... RETURNING` yield rows; plain writes yield [].
    if (/^SELECT/i.test(text) || /RETURNING/i.test(text)) {
      return Promise.resolve(returnRows)
    }
    return Promise.resolve([])
  }
  // Every helper now runs inside a platform-scoped transaction (ADR-0041), so
  // the fake answers both call styles: as a tagged template for the statement
  // itself, and as a client exposing `.begin` / `.unsafe` for the step-up.
  fn.begin = (cb) => cb(fn)
  fn.unsafe = (text) => {
    executed.push({ text, values: [] })
    return Promise.resolve([])
  }
  return { fn, executed }
}

/** Statements a helper ran, excluding the `SET LOCAL ROLE` step-up. */
function queries(executed) {
  return executed.filter((q) => !q.text.startsWith('SET LOCAL ROLE'))
}

describe('claimNext', () => {
  it('selects a due row with backoff, stale-reclaim, hold and attempt guards, then claims it', async () => {
    const { fn, executed } = makeSql([{ id: 'e1', entity_type: 'project' }])

    const entry = await claimNext(fn)

    expect(entry).toEqual({ id: 'e1', entity_type: 'project' })
    expect(queries(executed)).toHaveLength(2)

    const select = queries(executed)[0]
    expect(select.text).toMatch(/^SELECT q\.\* FROM deletion_queue q/)
    // pending branch has exponential backoff off claimed_at
    expect(select.text).toContain("q.status = 'pending' AND q.purge_after <= now()")
    expect(select.text).toContain('60 * power(2, least(q.attempts, 6))')
    // stale-reclaim branch for crashed purgers
    expect(select.text).toContain("q.status = 'purging' AND q.claimed_at < now()")
    // shared attempt cap + legal-hold guard + lock
    expect(select.text).toContain('q.attempts < $')
    expect(select.text).toContain('FROM legal_holds h')
    expect(select.text).toContain('h.released_at IS NULL')
    expect(select.text).toContain('FOR UPDATE SKIP LOCKED')
    expect(select.text).toContain('ORDER BY q.requested_at')
    // bindings: STALE_CLAIM_MINUTES (15) then MAX_ATTEMPTS
    expect(select.values).toEqual([15, MAX_ATTEMPTS])

    const claim = executed[1]
    expect(claim.text).toContain(
      "SET status = 'purging', claimed_at = now(), attempts = attempts + 1",
    )
    expect(claim.values).toEqual(['e1'])
  })

  it('returns null and issues no claim UPDATE when nothing is due', async () => {
    const { fn, executed } = makeSql([])

    const entry = await claimNext(fn)

    expect(entry).toBeNull()
    expect(queries(executed)).toHaveLength(1)
    expect(queries(executed)[0].text).toMatch(/^SELECT/)
  })
})

describe('reapStranded', () => {
  it("terminalizes 'purging' rows past max attempts + stale window to 'failed', preserving last_error", async () => {
    const { fn, executed } = makeSql([{ id: 'a' }, { id: 'b' }])

    const reaped = await reapStranded(fn)

    expect(reaped).toBe(2)
    expect(queries(executed)).toHaveLength(1)
    const q = queries(executed)[0]
    expect(q.text).toMatch(/^UPDATE deletion_queue/)
    expect(q.text).toContain("SET status = 'failed'")
    expect(q.text).toContain('COALESCE( last_error,')
    expect(q.text).toContain("WHERE status = 'purging'")
    expect(q.text).toContain('attempts >= $')
    expect(q.text).toContain('claimed_at < now() - make_interval(mins => $)')
    expect(q.text).toContain('RETURNING id')
    // does NOT re-attempt the purge — no SELECT/claim, pure state transition
    expect(q.values).toEqual([MAX_ATTEMPTS, 15])
  })

  it('reports zero when no rows are stranded', async () => {
    const { fn } = makeSql([])
    expect(await reapStranded(fn)).toBe(0)
  })
})

describe('releaseHeld', () => {
  it("returns the row to 'pending' and refunds one attempt (never below 0)", async () => {
    const { fn, executed } = makeSql()

    await releaseHeld(fn, 'e9')

    const q = queries(executed)[0]
    expect(q.text).toContain("SET status = 'pending'")
    expect(q.text).toContain('attempts = GREATEST(attempts - 1, 0)')
    expect(q.text).toContain('last_error =')
    expect(q.values).toEqual(['e9'])
  })
})

describe('markPurged', () => {
  it("marks 'purged', stamps purged_at, clears last_error", async () => {
    const { fn, executed } = makeSql()

    await markPurged(fn, 'e1')

    const q = queries(executed)[0]
    expect(q.text).toContain("SET status = 'purged', purged_at = now(), last_error = NULL")
    expect(q.values).toEqual(['e1'])
  })
})

describe('markFailed', () => {
  it("only reaches terminal 'failed' at MAX_ATTEMPTS, otherwise returns to 'pending' for retry", async () => {
    const { fn, executed } = makeSql()

    await markFailed(fn, 'e1', 'boom')

    const q = queries(executed)[0]
    expect(q.text).toContain(
      "SET status = CASE WHEN attempts >= $ THEN 'failed' ELSE 'pending' END",
    )
    // bindings: MAX_ATTEMPTS, message, id
    expect(q.values).toEqual([MAX_ATTEMPTS, 'boom', 'e1'])
  })

  it('truncates an oversized error message to 2000 chars', async () => {
    const { fn, executed } = makeSql()

    await markFailed(fn, 'e1', 'x'.repeat(5000))

    expect(queries(executed)[0].values[1]).toHaveLength(2000)
  })
})

describe('markFailedPermanent', () => {
  it("marks 'failed' unconditionally (no attempt-count CASE)", async () => {
    const { fn, executed } = makeSql()

    await markFailedPermanent(fn, 'e1', 'no purger registered')

    const q = queries(executed)[0]
    expect(q.text).toContain("SET status = 'failed'")
    expect(q.text).not.toContain('CASE')
    expect(q.values).toEqual(['no purger registered', 'e1'])
  })
})

/**
 * Losing the step-up would not fail loudly: row-level security would hide every
 * organization's rows, the queue would look permanently empty, and the purger
 * would report healthy ticks while deleting nothing (ADR-0041).
 */
describe('platform scope', () => {
  it('steps up to the BYPASSRLS role before every statement', async () => {
    for (const run of [
      (sql) => releaseHeld(sql, 'e1'),
      (sql) => markPurged(sql, 'e1'),
      (sql) => markFailed(sql, 'e1', 'boom'),
      (sql) => markFailedPermanent(sql, 'e1', 'boom'),
      (sql) => reapStranded(sql),
    ]) {
      const { fn, executed } = makeSql()
      await run(fn)
      expect(executed[0].text).toBe('SET LOCAL ROLE grid_app_platform')
      expect(executed).toHaveLength(2)
    }
  })
})
