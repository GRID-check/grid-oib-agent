/**
 * @vitest-environment node
 *
 * The claim loop over the REAL queue, against a real Postgres as `grid_app_rw`
 * (ADR-0079): what the unit spec proves with fakes, proved with the SQL.
 *
 * The claim a feature makes is not "the loop calls release", it is "a job whose
 * worker is drained is resumed by the next one, from where it stopped, and
 * nothing was spent". So the slices here are real calls through
 * `createRunner` and `workers/job-queue.js`, and only the BFF's work is a stub
 * that counts a cursor up.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run workers/jobs/runner.integration.spec.mjs
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as queue from '../job-queue.js'
import { createFailureStreak } from '../failure-streak.js'
import { withPlatformScope } from '../platform-scope.js'
import { createRunner } from './runner.js'

const url = process.env.GRID_TEST_DATABASE_URL
const LANE = `org_runner_${Date.now()}`

const CONFIG = {
  workerPrefix: 'runner-test',
  concurrency: 1,
  pollMs: 5,
  heartbeatMs: 60_000,
  staleSeconds: 180,
  maxAttempts: 3,
  perLaneCap: 0,
  reapEveryMs: 60_000,
  transientBackoffMs: 0,
  retryBackoffSeconds: 0,
  deadRetentionSeconds: 14 * 86_400,
  purgeEveryMs: 600_000,
}

describe('the suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('the bff-jobs claim loop against live Postgres', () => {
  let sql

  const quiet = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() })

  /** A runner whose BFF stub counts a cursor up to `last`, one step per slice. */
  function runnerWithSlices({ last, onSlice = async () => {} }) {
    const log = quiet()
    const runSlice = vi.fn(async (claim) => {
      await onSlice(claim)
      const cursor = Number(claim.payload.cursor ?? 0) + 1
      // What the route returns, and the loop saves: the NEXT state. A claim
      // object is the state at claim time, so a resumed job reads the saved one.
      claim.payload = { ...claim.payload, cursor }
      return cursor >= last ? { kind: 'done' } : { kind: 'more', payload: { ...claim.payload, cursor } }
    })
    const streak = createFailureStreak({ label: '[test]', escalateAfter: 5, log })
    const runner = createRunner(CONFIG, { sql, queue, runSlice, streak, log, sleep: () => Promise.resolve() })
    return { runner, runSlice, log }
  }

  const rowOf = async (jobId) =>
    (await withPlatformScope(sql, (tx) => tx`SELECT * FROM bff_job_queue WHERE job_id = ${jobId}::uuid`))[0]

  beforeAll(() => {
    sql = postgres(url, { prepare: false, max: 6 })
  })

  afterAll(async () => {
    if (!sql) return
    await withPlatformScope(sql, async (tx) => {
      await tx`DELETE FROM bff_job_queue WHERE lane = ${LANE}`
      await tx`DELETE FROM bff_job_lane_turns WHERE lane = ${LANE}`
    })
    await sql.end()
  })

  it('runs a job to its end, saving its progress after each slice, and deletes the row', async () => {
    const jobId = await queue.enqueue(sql, { kind: 'reindex_project', lane: LANE, priority: 1, payload: { cursor: 0 } })
    const { runner, runSlice } = runnerWithSlices({ last: 3 })

    expect(await runner.step('runner-test-0')).toBe(true)

    expect(runSlice).toHaveBeenCalledTimes(3)
    expect(await rowOf(jobId)).toBeUndefined()
  })

  it('gives a drained job back without spending an attempt, and the next worker resumes from its progress', async () => {
    const jobId = await queue.enqueue(sql, { kind: 'reindex_project', lane: LANE, priority: 1, payload: { cursor: 0 } })

    // Worker one: drained while its first slice is running. The slice finishes,
    // its progress is saved, and the claim is given back instead of continued.
    let release
    let sliceStarted
    const started = new Promise((resolve) => (sliceStarted = resolve))
    const first = runnerWithSlices({
      last: 5,
      onSlice: () => {
        sliceStarted()
        return new Promise((resolve) => (release = resolve))
      },
    })
    first.runner.start()
    await started
    const draining = first.runner.drain(10_000)
    release()
    await draining

    const afterDrain = await rowOf(jobId)
    expect(afterDrain).toMatchObject({ status: 'queued', attempts: 0, claimed_by: null })
    expect(afterDrain.payload.cursor).toBe(1)

    // Worker two claims it and carries on from the saved cursor.
    const second = runnerWithSlices({ last: 5 })
    expect(await second.runner.step('runner-test-1')).toBe(true)

    expect(second.runSlice).toHaveBeenCalledTimes(4) // cursor 1 -> 5
    expect(await rowOf(jobId)).toBeUndefined()
  })

  it('records a failed attempt with its reason, and the last one leaves a dead row', async () => {
    const jobId = await queue.enqueue(sql, { kind: 'reindex_project', lane: LANE, priority: 1, payload: {} })
    const log = quiet()
    const runSlice = vi.fn().mockResolvedValue({ kind: 'error', message: 'HTTP 500 the handler threw' })
    const runner = createRunner(CONFIG, {
      sql,
      queue,
      runSlice,
      streak: createFailureStreak({ label: '[test]', escalateAfter: 5, log }),
      log,
      sleep: () => Promise.resolve(),
    })

    for (let attempt = 1; attempt <= 3; attempt += 1) await runner.step('runner-test-2')

    const dead = await rowOf(jobId)
    expect(dead).toMatchObject({ status: 'dead', attempts: 3, last_error: 'HTTP 500 the handler threw' })
    // Nothing claims it again.
    expect(await runner.step('runner-test-2')).toBe(false)
  })

  it('spends an attempt on every failure but a drain, so a job that never gets an answer ends dead', async () => {
    const jobId = await queue.enqueue(sql, {
      kind: 'file_research_report',
      lane: LANE,
      priority: 1,
      payload: { runId: 'run-1', projectId: 'p-1', report: 'the whole report', requester: { email: 'person@example.test' } },
    })
    const log = quiet()
    const runSlice = vi.fn().mockResolvedValue({ kind: 'transient', failure: { kind: 'transport error (ECONNRESET)' } })
    const runner = createRunner(CONFIG, {
      sql,
      queue,
      runSlice,
      streak: createFailureStreak({ label: '[test]', escalateAfter: 50, log }),
      log,
      sleep: () => Promise.resolve(),
    })

    for (let round = 0; round < 5; round += 1) await runner.step('runner-test-3')

    expect(runSlice).toHaveBeenCalledTimes(3)
    const dead = await rowOf(jobId)
    expect(dead).toMatchObject({ status: 'dead', attempts: 3 })
    expect(dead.dead_at).toBeInstanceOf(Date)
    // The dead row is a trace: ids only, never the report or the requester.
    expect(dead.payload).toEqual({ runId: 'run-1', projectId: 'p-1' })
  })

  it('makes a failed job wait out its backoff before the next attempt', async () => {
    const jobId = await queue.enqueue(sql, { kind: 'reindex_project', lane: LANE, priority: 1, payload: {} })
    const log = quiet()
    const runSlice = vi.fn().mockResolvedValue({ kind: 'error', message: 'HTTP 500 boom' })
    const runner = createRunner(
      { ...CONFIG, retryBackoffSeconds: 30 },
      {
        sql,
        queue,
        runSlice,
        streak: createFailureStreak({ label: '[test]', escalateAfter: 5, log }),
        log,
        sleep: () => Promise.resolve(),
      },
    )

    expect(await runner.step('runner-test-4')).toBe(true)
    expect(await runner.step('runner-test-4')).toBe(false) // waiting

    expect(runSlice).toHaveBeenCalledTimes(1)
    expect(await rowOf(jobId)).toMatchObject({ status: 'queued', attempts: 1 })
  })
})
