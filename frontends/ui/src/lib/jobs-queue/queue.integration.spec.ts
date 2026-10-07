/**
 * Opt-in integration test: the `bff_job_queue` claim (ADR-0078), against a REAL
 * Postgres with every migration applied, connected as `grid_app_rw` — the role
 * the BFF and the runner actually run as.
 *
 * The scenarios are the Python claim's (`tests/knowledge_layer_tests/
 * test_ingest_queue.py`), one for one where the algorithm is the same: the claim
 * exists in two languages and two databases, and these are what hold them to one
 * algorithm. The extra ones are what this queue adds: priority inside a lane,
 * release without spending an attempt, and dead rows that keep their reason.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/jobs-queue/queue.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withPlatformScope } from '../../../workers/platform-scope.js'
import * as queue from './queue'

const url = process.env.GRID_TEST_DATABASE_URL

const STAMP = Date.now()
const lane = (name: string) => `org_jobq_${name}_${STAMP}`
const A = lane('a')
const B = lane('b')
const C = lane('c')

const OPTIONS = { staleSeconds: 180, maxAttempts: 3 }

/**
 * The suite is opt-in, and `describe.skipIf` exits 0 when it skips, so a green
 * job could have run nothing. See the same guard in the tenant-isolation suite.
 */
describe('the job-queue suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('bff_job_queue claim against live Postgres (migration 0102)', () => {
  let sql: postgres.Sql

  /** A job created at a fixed time, so the order a test asserts never depends on the clock. */
  async function seed(id: string, jobLane: string, createdAt: string, priority: 0 | 1 = 0): Promise<string> {
    const rows = await withPlatformScope(
      sql,
      (tx) => tx`
        INSERT INTO bff_job_queue (kind, lane, priority, payload, created_at)
        VALUES ('reindex_project', ${jobLane}, ${priority}, ${JSON.stringify({ id })}::text::jsonb, ${createdAt}::timestamptz)
        RETURNING job_id
      `,
    )
    return String(rows[0].job_id)
  }

  const idOf = (claim: { payload: Record<string, unknown> } | null) => claim?.payload.id

  async function row(jobId: string) {
    const rows = await withPlatformScope(sql, (tx) => tx`SELECT * FROM bff_job_queue WHERE job_id = ${jobId}::uuid`)
    return rows[0] as Record<string, unknown> | undefined
  }

  async function ageHeartbeat(jobId: string) {
    await withPlatformScope(
      sql,
      (tx) => tx`UPDATE bff_job_queue SET heartbeat_at = '2000-01-01T00:00:00Z' WHERE job_id = ${jobId}::uuid`,
    )
  }

  async function clearOurs() {
    await withPlatformScope(sql, async (tx) => {
      await tx`DELETE FROM bff_job_queue WHERE lane IN (${A}, ${B}, ${C})`
      await tx`DELETE FROM bff_job_lane_turns WHERE lane IN (${A}, ${B}, ${C})`
    })
  }

  /** Only our lanes count: other suites in the same database may hold jobs of their own. */
  async function claim(worker: string, extra: { perLaneCap?: number } = {}) {
    return queue.claimNext(sql, worker, { ...OPTIONS, ...extra })
  }

  beforeAll(() => {
    sql = postgres(url as string, { prepare: false, max: 12 })
  })
  beforeEach(clearOurs)
  afterAll(async () => {
    if (!sql) return
    await clearOurs()
    await sql.end()
  })

  it('has nothing to claim in an empty queue', async () => {
    expect(await claim('w1')).toBeNull()
  })

  it('serves a second office before the first one’s backlog', async () => {
    for (let i = 0; i < 5; i++) await seed(`a${i}`, A, `2026-09-30T10:00:0${i}Z`)
    await seed('b0', B, '2026-09-30T10:05:00Z')

    const first = await claim('w1')
    const second = await claim('w2')

    expect([idOf(first), idOf(second)]).toEqual(['a0', 'b0'])
  })

  it('serves the office with fewer running jobs first', async () => {
    for (let i = 0; i < 3; i++) await seed(`a${i}`, A, `2026-09-30T10:00:0${i}Z`)
    await seed('b0', B, '2026-09-30T10:00:09Z')
    await seed('b1', B, '2026-09-30T10:00:10Z')

    const claimed = []
    for (let i = 0; i < 4; i++) claimed.push(idOf(await claim(`w${i}`)))

    expect(claimed).toEqual(['a0', 'b0', 'a1', 'b1'])
  })

  it('alternates two backlogs when one worker finishes each job', async () => {
    for (let i = 0; i < 3; i++) await seed(`a${i}`, A, `2026-09-30T10:00:0${i}Z`)
    for (let i = 0; i < 3; i++) await seed(`b${i}`, B, `2026-09-30T10:01:0${i}Z`)

    const order = []
    for (let i = 0; i < 6; i++) {
      const next = await claim('w1')
      order.push(idOf(next))
      await queue.complete(sql, next!.jobId, 'w1')
    }

    expect(order).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'b2'])
  })

  it('serves an interactive job before an older bulk one in the same lane', async () => {
    await seed('bulk-old', A, '2026-09-30T10:00:00Z', 1)
    await seed('interactive-new', A, '2026-09-30T10:09:00Z', 0)

    const order = []
    for (let i = 0; i < 2; i++) {
      const next = await claim('w1')
      order.push(idOf(next))
      await queue.complete(sql, next!.jobId, 'w1')
    }

    expect(order).toEqual(['interactive-new', 'bulk-old'])
  })

  it('does not let priority jump the lane order: a fair turn beats a better priority elsewhere', async () => {
    await seed('a-interactive-0', A, '2026-09-30T10:00:00Z', 0)
    await seed('a-interactive-1', A, '2026-09-30T10:00:01Z', 0)
    await seed('b-bulk', B, '2026-09-30T10:00:02Z', 1)

    const first = await claim('w1') // A has no turn yet and nothing running; B ties, A is older
    const second = await claim('w2') // A now runs one: B's bulk job goes before A's second interactive

    expect([idOf(first), idOf(second)]).toEqual(['a-interactive-0', 'b-bulk'])
  })

  it('holds an office at its cap', async () => {
    await seed('a0', A, '2026-09-30T10:00:00Z')
    await seed('a1', A, '2026-09-30T10:00:01Z')

    expect(idOf(await claim('w1', { perLaneCap: 1 }))).toBe('a0')
    expect(await claim('w2', { perLaneCap: 1 })).toBeNull()
  })

  it('claims a dead worker’s job again, then marks it dead with its reason', async () => {
    const id = await seed('a0', A, '2026-09-30T10:00:00Z')

    for (let attempt = 1; attempt <= 3; attempt++) {
      const next = await claim(`w${attempt}`)
      expect([idOf(next), next?.attempts]).toEqual(['a0', attempt])
      expect(await claim('other')).toBeNull()
      await ageHeartbeat(id)
    }

    expect(await claim('w4')).toBeNull()
    expect(await queue.reapExhausted(sql, OPTIONS)).toEqual([id])
    const dead = await row(id)
    expect(dead?.status).toBe('dead')
    expect(String(dead?.last_error)).toMatch(/lost on its last attempt/)
    // Not deleted, and never claimed again.
    expect(await claim('w5')).toBeNull()
  })

  it('keeps the claim on a heartbeat, and says so when the claim is lost', async () => {
    const id = await seed('a0', A, '2026-09-30T10:00:00Z')
    await claim('w1')

    expect(await queue.heartbeat(sql, id, 'w1')).toBe(true)
    expect(await queue.heartbeat(sql, id, 'w2')).toBe(false)
    expect(await queue.complete(sql, id, 'w2')).toBe(false)
    expect(await queue.complete(sql, id, 'w1')).toBe(true)
    expect(await queue.heartbeat(sql, id, 'w1')).toBe(false)
    expect(await row(id)).toBeUndefined()
  })

  it('gives a claim back without spending an attempt, keeping the progress it saved', async () => {
    const id = await seed('a0', A, '2026-09-30T10:00:00Z')
    const first = await claim('w1')
    expect(first?.attempts).toBe(1)

    expect(await queue.saveProgress(sql, id, 'w1', { id: 'a0', cursor: 'page-3' })).toBe(true)
    expect(await queue.release(sql, id, 'w1')).toBe(true)
    expect(await queue.release(sql, id, 'w1')).toBe(false)

    const again = await claim('w2')
    expect(again?.attempts).toBe(1) // the drained claim cost nothing
    expect(again?.payload).toEqual({ id: 'a0', cursor: 'page-3' })
  })

  it('refuses progress from a worker that lost the claim', async () => {
    const id = await seed('a0', A, '2026-09-30T10:00:00Z')
    await claim('w1')
    await ageHeartbeat(id)
    await claim('w2') // takes the stale claim over

    expect(await queue.saveProgress(sql, id, 'w1', { id: 'a0', cursor: 'stale' })).toBe(false)
    expect(await queue.saveProgress(sql, id, 'w2', { id: 'a0', cursor: 'fresh' })).toBe(true)
  })

  it('queues a failed attempt again, and marks the last one dead with the reason', async () => {
    const id = await seed('a0', A, '2026-09-30T10:00:00Z')

    for (let attempt = 1; attempt <= 2; attempt++) {
      await claim('w1')
      expect(await queue.fail(sql, id, 'w1', new Error(`boom ${attempt}`), 3, 0)).toBe('queued')
    }
    await claim('w1')
    expect(await queue.fail(sql, id, 'w1', new Error('boom 3'), 3, 0)).toBe('dead')

    const dead = await row(id)
    expect([dead?.status, dead?.last_error, dead?.claimed_by]).toEqual(['dead', 'boom 3', null])
    expect(await queue.fail(sql, id, 'w1', new Error('late'), 3, 0)).toBeNull()
  })

  it('keeps a failed job out of the claim until its backoff has passed, and doubles the wait per attempt', async () => {
    const id = await seed('a0', A, '2026-09-30T10:00:00Z')
    const waitOf = async () => {
      const r = await withPlatformScope(
        sql,
        (tx) => tx`SELECT EXTRACT(EPOCH FROM (not_before - now()))::float8 AS wait FROM bff_job_queue WHERE job_id = ${id}::uuid`,
      )
      return Number(r[0].wait)
    }

    await claim('w1')
    expect(await queue.fail(sql, id, 'w1', new Error('boom'), 3, 60)).toBe('queued')
    expect(await waitOf()).toBeGreaterThan(55)
    expect(await waitOf()).toBeLessThanOrEqual(60)
    expect(await claim('w2')).toBeNull() // waiting: neither a lane nor a candidate

    await withPlatformScope(sql, (tx) => tx`UPDATE bff_job_queue SET not_before = now() - interval '1 second' WHERE job_id = ${id}::uuid`)
    const second = await claim('w2')
    expect([idOf(second), second?.attempts]).toEqual(['a0', 2])
    expect((await row(id))?.not_before).toBeNull()

    expect(await queue.fail(sql, id, 'w2', new Error('boom'), 3, 60)).toBe('queued')
    expect(await waitOf()).toBeGreaterThan(115) // 60 s x 2 after the second attempt
    expect(await waitOf()).toBeLessThanOrEqual(120)
  })

  it('caps the backoff, and a drain gives a job back with no wait', async () => {
    const id = await seed('a0', A, '2026-09-30T10:00:00Z')
    await withPlatformScope(sql, (tx) => tx`UPDATE bff_job_queue SET attempts = 9 WHERE job_id = ${id}::uuid`)
    await withPlatformScope(
      sql,
      (tx) => tx`UPDATE bff_job_queue SET status = 'claimed', claimed_by = 'w1', heartbeat_at = now() WHERE job_id = ${id}::uuid`,
    )

    await queue.fail(sql, id, 'w1', new Error('boom'), 99, 600)
    const wait = await withPlatformScope(
      sql,
      (tx) => tx`SELECT EXTRACT(EPOCH FROM (not_before - now()))::float8 AS wait FROM bff_job_queue WHERE job_id = ${id}::uuid`,
    )
    expect(Number(wait[0].wait)).toBeLessThanOrEqual(queue.MAX_RETRY_BACKOFF_SECONDS)
    expect(Number(wait[0].wait)).toBeGreaterThan(queue.MAX_RETRY_BACKOFF_SECONDS - 5)

    await withPlatformScope(sql, (tx) => tx`UPDATE bff_job_queue SET not_before = NULL, status = 'queued' WHERE job_id = ${id}::uuid`)
    await claim('w1')
    await queue.release(sql, id, 'w1')
    expect((await row(id))?.not_before).toBeNull()
    expect(idOf(await claim('w2'))).toBe('a0')
  })

  it('reduces a row to its identifiers when it goes dead, whichever way it gets there', async () => {
    const payload = {
      runId: 'run-1',
      projectId: 'p-1',
      documentId: 'd-1',
      taskRunId: 't-1',
      report: 'the whole report',
      storageKey: 'org/x/project/p-1/file.pdf',
      requester: { email: 'person@example.test', permissions: ['org:projects:administer'] },
    }
    const insert = (id: string) =>
      withPlatformScope(
        sql,
        (tx) => tx`
          INSERT INTO bff_job_queue (kind, lane, payload, created_at)
          VALUES ('file_research_report', ${A}, ${JSON.stringify({ id, ...payload })}::text::jsonb, '2026-09-30T10:00:00Z'::timestamptz)
          RETURNING job_id
        `,
      ).then((rows) => String(rows[0].job_id))
    const kept = { runId: 'run-1', projectId: 'p-1', documentId: 'd-1', taskRunId: 't-1' }

    const failed = await insert('failed')
    await claim('w1')
    expect(await queue.fail(sql, failed, 'w1', new Error('boom'), 1, 0)).toBe('dead')
    const failedRow = await row(failed)
    expect(failedRow?.payload).toEqual(kept)
    expect(failedRow?.dead_at).toBeInstanceOf(Date)
    expect(failedRow?.not_before).toBeNull()

    const lost = await insert('lost')
    await claim('w1')
    await ageHeartbeat(lost)
    expect(await queue.reapExhausted(sql, { staleSeconds: 180, maxAttempts: 1 })).toEqual([lost])
    const lostRow = await row(lost)
    expect(lostRow?.payload).toEqual(kept)
    expect(lostRow?.dead_at).toBeInstanceOf(Date)
  })

  it('refuses a dead row that was not stamped, so the retention can always reach it', async () => {
    const id = await seed('a0', A, '2026-09-30T10:00:00Z')

    await expect(
      withPlatformScope(sql, (tx) => tx`UPDATE bff_job_queue SET status = 'dead' WHERE job_id = ${id}::uuid`),
    ).rejects.toThrow(/bff_job_queue_dead_stamped/)
  })

  it('deletes dead rows past their retention, and nothing else', async () => {
    const old = await seed('old', A, '2026-09-30T10:00:00Z')
    const recent = await seed('recent', A, '2026-09-30T10:00:01Z')
    const live = await seed('live', A, '2026-09-30T10:00:02Z')
    await withPlatformScope(sql, async (tx) => {
      await tx`UPDATE bff_job_queue SET status = 'dead', dead_at = now() - interval '20 days' WHERE job_id = ${old}::uuid`
      await tx`UPDATE bff_job_queue SET status = 'dead', dead_at = now() - interval '1 day' WHERE job_id = ${recent}::uuid`
    })

    expect(await queue.purgeDead(sql, { olderThanSeconds: 14 * 86_400 })).toBeGreaterThanOrEqual(1)

    expect(await row(old)).toBeUndefined()
    expect(await row(recent)).toBeDefined()
    expect(await row(live)).toBeDefined()
  })

  it('erases a project’s jobs in every state, and only that project’s, in the purge transaction', async () => {
    const forProject = (id: string, lane: string, projectId: string | null, status = 'queued') =>
      withPlatformScope(
        sql,
        (tx) => tx`
          INSERT INTO bff_job_queue (kind, lane, status, dead_at, payload)
          VALUES ('office_rendition', ${lane}, ${status}, ${status === 'dead' ? new Date() : null},
                  ${JSON.stringify({ id, projectId })}::text::jsonb)
          RETURNING job_id
        `,
      ).then((rows) => String(rows[0].job_id))
    const mine = await forProject('mine', A, 'p-gone')
    const mineDead = await forProject('mine-dead', A, 'p-gone', 'dead')
    const otherProject = await forProject('other-project', A, 'p-kept')
    const otherOrg = await forProject('other-org', B, 'p-gone')
    const orgLevel = await forProject('org-level', A, null)

    const erased = await withPlatformScope(sql, (tx) => queue.eraseProject(tx, A, 'p-gone'))

    expect(erased).toBe(2)
    expect([await row(mine), await row(mineDead)]).toEqual([undefined, undefined])
    for (const id of [otherProject, otherOrg, orgLevel]) expect(await row(id)).toBeDefined()
  })

  it('erases an organization’s jobs and its place in the rotation', async () => {
    await seed('a0', A, '2026-09-30T10:00:00Z')
    await seed('b0', B, '2026-09-30T10:00:01Z')
    await claim('w1') // gives lane A a turn

    const erased = await withPlatformScope(sql, (tx) => queue.eraseLane(tx, A))

    expect(erased).toBe(1)
    const left = await withPlatformScope(
      sql,
      (tx) => tx`SELECT (SELECT COUNT(*)::int FROM bff_job_queue WHERE lane = ${A}) AS jobs, (SELECT COUNT(*)::int FROM bff_job_lane_turns WHERE lane = ${A}) AS turns`,
    )
    expect([left[0].jobs, left[0].turns]).toEqual([0, 0])
    expect(idOf(await claim('w2'))).toBe('b0')
  })

  it('counts every job but the dead ones as depth', async () => {
    const before = await queue.depth(sql)
    await seed('a0', A, '2026-09-30T10:00:00Z')
    const dead = await seed('a1', A, '2026-09-30T10:00:01Z')
    await withPlatformScope(sql, (tx) => tx`UPDATE bff_job_queue SET status = 'dead', dead_at = now() WHERE job_id = ${dead}::uuid`)

    expect(await queue.depth(sql)).toBe(before + 1)
  })

  it('never claims one job twice among racing workers', async () => {
    const lanes = [A, B, C]
    for (let i = 0; i < 30; i++) await seed(`j${i}`, lanes[i % 3], `2026-09-30T10:00:${String(i).padStart(2, '0')}Z`)

    const drain = async (worker: string) => {
      const mine: unknown[] = []
      for (let next = await claim(worker); next; next = await claim(worker)) mine.push(idOf(next))
      return mine
    }
    const batches = await Promise.all(Array.from({ length: 8 }, (_, i) => drain(`w${i}`)))
    const claimed = batches.flat().map(String).sort()

    expect(claimed).toEqual(Array.from({ length: 30 }, (_, i) => `j${i}`).sort())
  })

  it('never lets racing workers exceed the cap', async () => {
    for (let i = 0; i < 20; i++) await seed(`a${i}`, A, `2026-09-30T10:00:${String(i).padStart(2, '0')}Z`)

    for (let round = 0; round < 5; round++) {
      await Promise.all(Array.from({ length: 8 }, (_, i) => claim(`w${i}`, { perLaneCap: 2 })))
    }

    const held = await withPlatformScope(
      sql,
      (tx) => tx`SELECT COUNT(*)::int AS n FROM bff_job_queue WHERE lane = ${A} AND status = 'claimed'`,
    )
    expect(Number(held[0].n)).toBe(2)
  })

  it('shows a tenant only its own jobs, and lets it enqueue only into its own lane', async () => {
    await seed('a0', A, '2026-09-30T10:00:00Z')
    await seed('b0', B, '2026-09-30T10:00:01Z')

    const seenByA = await sql.begin(async (tx) => {
      await tx`SELECT set_config('grid.organization_id', ${A}, true)`
      return tx`SELECT lane FROM bff_job_queue WHERE lane IN (${A}, ${B})`
    })
    expect(seenByA.map((r) => r.lane)).toEqual([A])

    const forged = sql.begin(async (tx) => {
      await tx`SELECT set_config('grid.organization_id', ${A}, true)`
      await tx`INSERT INTO bff_job_queue (kind, lane) VALUES ('reindex_project', ${B})`
    })
    await expect(forged).rejects.toThrow(/row-level security/)
  })

  it('refuses a status, a priority and a kind the claim does not know', async () => {
    const insert = (status: string, priority: number, kind: string) =>
      withPlatformScope(
        sql,
        (tx) => tx`
          INSERT INTO bff_job_queue (kind, lane, priority, status, claimed_by, heartbeat_at)
          VALUES (${kind}, ${A}, ${priority}, ${status}, 'w', now())
        `,
      )

    await expect(insert('done', 0, 'reindex_project')).rejects.toThrow(/bff_job_queue_status/)
    await expect(insert('queued', 2, 'reindex_project')).rejects.toThrow(/bff_job_queue_priority/)
    await expect(insert('queued', 0, 'Reindex Project')).rejects.toThrow(/bff_job_queue_kind_shape/)
    await expect(
      withPlatformScope(sql, (tx) => tx`INSERT INTO bff_job_queue (kind, lane, status) VALUES ('reindex_project', ${A}, 'claimed')`),
    ).rejects.toThrow(/bff_job_queue_claim_attributed/)
  })
})
