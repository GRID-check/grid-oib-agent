/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { claimDue, pruneOldRuns, PRUNE_BATCH } from './db.js'

// Same fake-sql idiom as purger/db.spec.mjs: a tagged-template fn that records
// the rendered SQL text (`join('$')` renders each interpolation as `$`) plus the
// bound values in order. claimDue runs inside `sql.begin`, so we hand it a `sql`
// object whose `.begin(cb)` invokes cb with the recording tx template.
function makeClaimSql(selectRows) {
  const executed = []
  const tx = (strings, ...values) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    executed.push({ text, values })
    if (/^SELECT/i.test(text)) return Promise.resolve(selectRows)
    return Promise.resolve([])
  }
  const sql = { begin: (cb) => cb(tx) }
  return { sql, executed }
}

// pruneOldRuns calls the client directly as a tagged template (no begin). Each
// DELETE returns the next array from `sequence`; a short final batch ends loop.
function makePruneSql(sequence) {
  const executed = []
  let i = 0
  const sql = (strings, ...values) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    executed.push({ text, values })
    const rows = sequence[i] ?? []
    i += 1
    return Promise.resolve(rows)
  }
  return { sql, executed }
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

    const select = executed[0]
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
    expect(executed[0].values).toEqual([5])
  })

  it('returns an empty array and issues no UPDATE when nothing is due', async () => {
    const { sql, executed } = makeClaimSql([])
    const claimed = await claimDue(sql, 20, vi.fn())
    expect(claimed).toEqual([])
    expect(executed).toHaveLength(1)
    expect(executed[0].text).toMatch(/^SELECT/)
  })
})

describe('pruneOldRuns', () => {
  it('deletes older rows in batches until a short batch, summing the total', async () => {
    const fullBatch = Array.from({ length: PRUNE_BATCH }, (_, i) => ({ id: `r${i}` }))
    const shortBatch = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
    const { sql, executed } = makePruneSql([fullBatch, shortBatch])

    const total = await pruneOldRuns(sql, 90)

    expect(total).toBe(PRUNE_BATCH + 3)
    expect(executed).toHaveLength(2) // looped once more after the full batch

    const del = executed[0]
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
    expect(executed).toHaveLength(1)
    expect(executed[0].values).toEqual([30, PRUNE_BATCH])
  })

  it('returns 0 when nothing is old enough', async () => {
    const { sql, executed } = makePruneSql([[]])
    expect(await pruneOldRuns(sql, 90)).toBe(0)
    expect(executed).toHaveLength(1)
  })
})
