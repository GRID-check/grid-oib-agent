import { describe, expect, it, vi } from 'vitest'
import { claimDue, pruneOldRuns, PLATFORM_ROLE, PRUNE_BATCH } from './db.js'

// Same fake-sql idiom as purger/db.spec.mjs: a tagged-template fn that records
// the rendered SQL text (`join('$')` renders each interpolation as `$`) plus the
// bound values in order. Both entry points run inside `sql.begin`, so the fake
// `sql` exposes `.begin(cb)` and invokes cb with the recording tx template.
//
// The tx also records `.unsafe()` calls: every transaction must step up to the
// BYPASSRLS role before it queries, because the scheduler's work spans tenants
// and row-level security would otherwise hide every due row (ADR-0041).
function makeTx(executed, respond) {
  const tx = (strings, ...values) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    executed.push({ text, values })
    return Promise.resolve(respond(text))
  }
  tx.unsafe = (text) => {
    executed.push({ text, values: [] })
    return Promise.resolve([])
  }
  return tx
}

function makeClaimSql(selectRows) {
  const executed = []
  const tx = makeTx(executed, (text) => (/^SELECT/i.test(text) ? selectRows : []))
  return { sql: { begin: (cb) => cb(tx) }, executed }
}

// Each DELETE returns the next array from `sequence`; a short final batch ends
// the loop. One transaction per batch, so `begin` is called per iteration.
function makePruneSql(sequence) {
  const executed = []
  let i = 0
  const tx = makeTx(executed, () => {
    const rows = sequence[i] ?? []
    i += 1
    return rows
  })
  return { sql: { begin: (cb) => cb(tx) }, executed }
}

/** The statements a transaction ran, excluding the platform step-up. */
function queries(executed) {
  return executed.filter((q) => !q.text.startsWith('SET LOCAL ROLE'))
}

describe('claimDue', () => {
  it('claims due rows and advances each next_run_at to the computed future time', async () => {
    const rows = [
      { id: 'w1', schedule_cron: '0 9 * * *', schedule_timezone: 'UTC' },
      { id: 'w2', schedule_cron: '*/15 * * * *', schedule_timezone: 'Europe/Vienna' },
    ]
    const { sql, executed } = makeClaimSql(rows)
    const nextDate = new Date('2026-07-17T09:00:00Z')
    const computeNext = vi.fn().mockReturnValue(nextDate)

    const claimed = await claimDue(sql, 20, computeNext)

    expect(claimed).toEqual(rows)

    const select = queries(executed)[0]
    expect(select.text).toMatch(/^SELECT id, schedule_cron, schedule_timezone FROM workflows/)
    expect(select.text).toContain('WHERE enabled AND schedule_cron IS NOT NULL AND next_run_at <= now()')
    expect(select.text).toContain('ORDER BY next_run_at')
    expect(select.text).toContain('LIMIT $')
    expect(select.text).toContain('FOR UPDATE SKIP LOCKED')
    expect(select.values).toEqual([20]) // batch binding

    // computeNext consulted per row with its own cron + timezone
    expect(computeNext).toHaveBeenNthCalledWith(1, '0 9 * * *', 'UTC')
    expect(computeNext).toHaveBeenNthCalledWith(2, '*/15 * * * *', 'Europe/Vienna')

    // one advancing UPDATE per row, binding the computed Date then the id
    const updates = executed.filter((q) => q.text.startsWith('UPDATE workflows SET next_run_at'))
    expect(updates).toHaveLength(2)
    expect(updates[0].values).toEqual([nextDate, 'w1'])
    expect(updates[1].values).toEqual([nextDate, 'w2'])
  })

  it('disables a row whose cron is unparseable and excludes it from the claim, still advancing the rest', async () => {
    const rows = [
      { id: 'bad', schedule_cron: 'garbage', schedule_timezone: 'UTC' },
      { id: 'good', schedule_cron: '0 9 * * *', schedule_timezone: 'UTC' },
    ]
    const { sql, executed } = makeClaimSql(rows)
    const nextDate = new Date('2026-07-17T09:00:00Z')
    const computeNext = vi.fn((cron) => {
      if (cron === 'garbage') throw new Error('unparseable')
      return nextDate
    })

    const claimed = await claimDue(sql, 20, computeNext)

    // only the good row is returned to be fired
    expect(claimed).toEqual([rows[1]])

    // the bad row is disabled (and its next_run_at cleared), not advanced
    const disable = executed.find((q) => q.text.includes('SET enabled = false'))
    expect(disable).toBeDefined()
    expect(disable.text).toContain('next_run_at = NULL')
    expect(disable.values).toEqual(['bad'])

    // the good row is advanced normally
    const advance = executed.find((q) => q.text.startsWith('UPDATE workflows SET next_run_at'))
    expect(advance.values).toEqual([nextDate, 'good'])
  })

  it('passes the batch size through as the LIMIT binding', async () => {
    const { sql, executed } = makeClaimSql([])
    await claimDue(sql, 5, vi.fn())
    expect(queries(executed)[0].values).toEqual([5])
  })

  it('returns an empty array and issues no UPDATE when nothing is due', async () => {
    const { sql, executed } = makeClaimSql([])
    const claimed = await claimDue(sql, 20, vi.fn())
    expect(claimed).toEqual([])
    expect(queries(executed)).toHaveLength(1)
    expect(queries(executed)[0].text).toMatch(/^SELECT/)
  })
})

describe('pruneOldRuns', () => {
  it('deletes older rows in batches until a short batch, summing the total', async () => {
    const fullBatch = Array.from({ length: PRUNE_BATCH }, (_, i) => ({ id: `r${i}` }))
    const shortBatch = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
    const { sql, executed } = makePruneSql([fullBatch, shortBatch])

    const total = await pruneOldRuns(sql, 90)

    expect(total).toBe(PRUNE_BATCH + 3)
    expect(queries(executed)).toHaveLength(2) // looped once more after the full batch

    const del = queries(executed)[0]
    expect(del.text).toMatch(/^DELETE FROM workflow_runs/)
    expect(del.text).toContain('make_interval(days => $)')
    expect(del.text).toContain('LIMIT $')
    expect(del.text).toContain('RETURNING id')
    expect(del.values).toEqual([90, PRUNE_BATCH]) // retentionDays, batch limit
  })

  it('stops after a single sub-batch delete and returns its count', async () => {
    const { sql, executed } = makePruneSql([[{ id: 'a' }, { id: 'b' }]])
    const total = await pruneOldRuns(sql, 30)
    expect(total).toBe(2)
    expect(queries(executed)).toHaveLength(1)
    expect(queries(executed)[0].values).toEqual([30, PRUNE_BATCH])
  })

  it('returns 0 when nothing is old enough', async () => {
    const { sql, executed } = makePruneSql([[]])
    expect(await pruneOldRuns(sql, 90)).toBe(0)
    expect(queries(executed)).toHaveLength(1)
  })
})

/**
 * Losing the step-up would not fail loudly: row-level security would simply
 * hide every other tenant's rows, the due-scan would return nothing, and the
 * scheduler would go quiet while reporting healthy ticks. These assertions are
 * the only thing standing between that and a silent outage (ADR-0041).
 */
describe('platform scope', () => {
  it('steps up to the BYPASSRLS role before claiming, inside the same transaction', async () => {
    const { sql, executed } = makeClaimSql([])
    await claimDue(sql, 20, vi.fn())

    expect(executed[0].text).toBe(`SET LOCAL ROLE ${PLATFORM_ROLE}`)
    expect(executed[1].text).toMatch(/^SELECT/)
  })

  it('steps up in every prune batch, since each is its own transaction', async () => {
    const fullBatch = Array.from({ length: PRUNE_BATCH }, (_, i) => ({ id: `r${i}` }))
    const { sql, executed } = makePruneSql([fullBatch, [{ id: 'x' }]])

    await pruneOldRuns(sql, 90)

    const stepUps = executed.filter((q) => q.text === `SET LOCAL ROLE ${PLATFORM_ROLE}`)
    expect(stepUps).toHaveLength(2)
    // …and each one precedes its own DELETE rather than all landing up front.
    expect(executed.map((q) => (q.text.startsWith('SET LOCAL ROLE') ? 'role' : 'query'))).toEqual([
      'role',
      'query',
      'role',
      'query',
    ])
  })
})
