/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { createFailureStreak } from '../failure-streak.js'
import { readConfig, waitForServer } from './index.js'
import { createRunner, createSliceRunner } from './runner.js'

const CONFIG = {
  workerPrefix: 'w',
  concurrency: 1,
  pollMs: 1,
  heartbeatMs: 60_000,
  staleSeconds: 180,
  maxAttempts: 3,
  perLaneCap: 0,
  reapEveryMs: 60_000,
  transientBackoffMs: 0,
}

const CLAIM = { jobId: 'job-1', kind: 'reindex_project', lane: 'org-a', priority: 1, payload: {}, attempts: 1 }

function quietLog() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** A queue whose every verb succeeds, recording the calls the loop makes. */
function fakeQueue(overrides = {}) {
  return {
    claimNext: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    saveProgress: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue('queued'),
    reapExhausted: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function runnerOver(queue, slices, extra = {}) {
  const log = quietLog()
  const streak = createFailureStreak({ label: '[test]', escalateAfter: 5, log })
  const runSlice = vi.fn()
  for (const outcome of slices) runSlice.mockResolvedValueOnce(outcome)
  const runner = createRunner(
    { ...CONFIG, ...extra },
    { sql: /** @type {never} */ ({}), queue, runSlice, streak, log, sleep: () => Promise.resolve() },
  )
  return { runner, runSlice, log }
}

describe('a claimed job', () => {
  it('runs slice after slice until the BFF says it is done, then leaves the queue', async () => {
    const queue = fakeQueue()
    const { runner, runSlice } = runnerOver(queue, [
      { kind: 'more', payload: { cursor: 1 } },
      { kind: 'more', payload: { cursor: 2 } },
      { kind: 'done' },
    ])

    await runner.runClaim(CLAIM, 'w-0')

    expect(runSlice).toHaveBeenCalledTimes(3)
    expect(queue.saveProgress.mock.calls.map((call) => call[3])).toEqual([{ cursor: 1 }, { cursor: 2 }])
    expect(queue.complete).toHaveBeenCalledWith(expect.anything(), 'job-1', 'w-0')
    expect(queue.fail).not.toHaveBeenCalled()
    expect(queue.release).not.toHaveBeenCalled()
    expect(runner.inFlight()).toBe(0)
  })

  it('records a failed attempt with its reason, and says when the last one made it dead', async () => {
    const queue = fakeQueue({ fail: vi.fn().mockResolvedValue('dead') })
    const { runner, log } = runnerOver(queue, [{ kind: 'error', message: 'HTTP 500 boom' }])

    await runner.runClaim({ ...CLAIM, attempts: 3 }, 'w-0')

    expect(queue.fail).toHaveBeenCalledWith(expect.anything(), 'job-1', 'w-0', 'HTTP 500 boom', 3)
    expect(queue.complete).not.toHaveBeenCalled()
    expect(log.error.mock.calls.map((c) => c[0]).join('\n')).toMatch(/now dead: job-1/)
  })

  it('does not spend an attempt when the BFF was briefly unavailable', async () => {
    const queue = fakeQueue()
    const { runner, log } = runnerOver(queue, [{ kind: 'transient', failure: { kind: 'HTTP 503' } }])

    await runner.runClaim(CLAIM, 'w-0')

    expect(queue.release).toHaveBeenCalledWith(expect.anything(), 'job-1', 'w-0')
    expect(queue.fail).not.toHaveBeenCalled()
    expect(log.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/HTTP 503/)
  })

  it('stops when the progress cannot be saved, because the claim is gone', async () => {
    const queue = fakeQueue({ saveProgress: vi.fn().mockResolvedValue(false) })
    const { runner, runSlice } = runnerOver(queue, [{ kind: 'more', payload: {} }])

    await runner.runClaim(CLAIM, 'w-0')

    expect(runSlice).toHaveBeenCalledTimes(1)
    expect(queue.complete).not.toHaveBeenCalled()
    expect(queue.release).not.toHaveBeenCalled()
  })

  it('stops quietly when the BFF says the claim is no longer this worker’s', async () => {
    const queue = fakeQueue()
    const { runner } = runnerOver(queue, [{ kind: 'lost' }])

    await runner.runClaim(CLAIM, 'w-0')

    expect(queue.complete).not.toHaveBeenCalled()
    expect(queue.fail).not.toHaveBeenCalled()
    expect(queue.release).not.toHaveBeenCalled()
  })

  it('stops before the next slice when a heartbeat finds the claim lost', async () => {
    vi.useFakeTimers()
    try {
      const queue = fakeQueue({ heartbeat: vi.fn().mockResolvedValue(false) })
      const { runner, runSlice } = runnerOver(queue, [], { heartbeatMs: 10 })
      runSlice.mockImplementationOnce(async () => {
        await vi.advanceTimersByTimeAsync(25)
        return { kind: 'more', payload: {} }
      })

      await runner.runClaim(CLAIM, 'w-0')

      expect(runSlice).toHaveBeenCalledTimes(1)
      expect(queue.complete).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('draining', () => {
  it('lets the slice in hand finish, then gives the claim back without spending an attempt', async () => {
    const queue = fakeQueue()
    const { runner, runSlice } = runnerOver(queue, [])
    let finishSlice = () => {}
    runSlice.mockImplementationOnce(() => new Promise((resolve) => (finishSlice = () => resolve({ kind: 'more', payload: { cursor: 1 } }))))
    queue.claimNext.mockResolvedValueOnce(CLAIM)

    runner.start()
    await vi.waitFor(() => expect(runner.inFlight()).toBe(1))
    const draining = runner.drain(5_000)
    finishSlice()
    const released = await draining

    expect(released).toBe(0)
    expect(runSlice).toHaveBeenCalledTimes(1) // no second slice once draining
    expect(queue.saveProgress).toHaveBeenCalledTimes(1) // what the slice got to is kept
    expect(queue.release).toHaveBeenCalledWith(expect.anything(), 'job-1', expect.stringMatching(/^w-/))
    expect(queue.fail).not.toHaveBeenCalled()
    expect(queue.complete).not.toHaveBeenCalled()
  })

  it('releases a slice that outlives the drain budget as it stands', async () => {
    const queue = fakeQueue()
    const { runner, runSlice } = runnerOver(queue, [])
    runSlice.mockImplementationOnce(() => new Promise(() => {})) // never answers
    queue.claimNext.mockResolvedValueOnce(CLAIM)

    runner.start()
    await vi.waitFor(() => expect(runner.inFlight()).toBe(1))
    const released = await runner.drain(20)

    expect(released).toBe(1)
    expect(queue.release).toHaveBeenCalledTimes(1)
    expect(queue.fail).not.toHaveBeenCalled()
  })

  it('claims nothing once draining', async () => {
    const queue = fakeQueue()
    const { runner } = runnerOver(queue, [])

    await runner.drain(10)
    runner.start()

    expect(queue.claimNext).not.toHaveBeenCalled()
  })
})

describe('the claim loop', () => {
  it('marks exhausted claims dead, at most once per interval', async () => {
    const queue = fakeQueue({ reapExhausted: vi.fn().mockResolvedValue(['dead-1']) })
    const { runner, log } = runnerOver(queue, [])

    await runner.step('w-0')
    await runner.step('w-0')

    expect(queue.reapExhausted).toHaveBeenCalledTimes(1)
    expect(log.error.mock.calls.map((c) => c[0]).join('\n')).toMatch(/1 job\(s\) lost their worker/)
  })

  it('treats a database outage as a warning to retry, not an error', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const queue = fakeQueue({ claimNext: vi.fn().mockRejectedValue(down) })
    const { runner, log } = runnerOver(queue, [])

    expect(await runner.step('w-0')).toBe(false)

    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/database unavailable \(ECONNREFUSED\)/)
  })

  it('logs any other claim failure at error and keeps going', async () => {
    const queue = fakeQueue({ claimNext: vi.fn().mockRejectedValue(new Error('syntax error')) })
    const { runner, log } = runnerOver(queue, [])

    expect(await runner.step('w-0')).toBe(false)

    expect(log.error).toHaveBeenCalledTimes(1)
  })
})

describe('the slice request', () => {
  const respond = (status, body = {}) =>
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )
  const sliceOver = (fetchImpl) =>
    createSliceRunner({ url: 'http://127.0.0.1:3000', token: 't', timeoutMs: 1000, fetchImpl })

  it('names only the job and the worker, with the internal token', async () => {
    const fetchImpl = respond(200, { done: true })

    expect(await sliceOver(fetchImpl)(CLAIM, 'w-0')).toEqual({ kind: 'done' })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:3000/api/internal/jobs/run')
    expect(init.headers['x-grid-internal-token']).toBe('t')
    expect(JSON.parse(init.body)).toEqual({ jobId: 'job-1', worker: 'w-0' })
  })

  it('reads done: false as another slice to run, with the progress to save', async () => {
    const outcome = await sliceOver(respond(200, { done: false, payload: { cursor: 'p2' } }))(CLAIM, 'w-0')
    expect(outcome).toEqual({ kind: 'more', payload: { cursor: 'p2' } })
  })

  it('reads a 409 as a lost claim', async () => {
    expect(await sliceOver(respond(409, { error: 'not claimed' }))(CLAIM, 'w-0')).toEqual({ kind: 'lost' })
  })

  it('reads a gateway or outage status as transient, and any other status as the job’s failure', async () => {
    expect((await sliceOver(respond(503))(CLAIM, 'w-0')).kind).toBe('transient')
    expect((await sliceOver(respond(502))(CLAIM, 'w-0')).kind).toBe('transient')
    const failed = await sliceOver(respond(500, { error: 'the handler threw' }))(CLAIM, 'w-0')
    expect(failed.kind).toBe('error')
    expect(failed.message).toMatch(/HTTP 500/)
  })

  it('reads a refused connection as transient', async () => {
    const refused = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) })
    const outcome = await sliceOver(vi.fn().mockRejectedValue(refused))(CLAIM, 'w-0')
    expect(outcome.kind).toBe('transient')
  })
})

describe('configuration', () => {
  it('has defaults a pod can run on', () => {
    const config = readConfig({ HOSTNAME: 'pod-1' })

    expect(config.url).toBe('http://127.0.0.1:3000')
    expect(config.runner).toMatchObject({ workerPrefix: 'bff-jobs-pod-1', concurrency: 2, maxAttempts: 3, perLaneCap: 0 })
    expect(config.drainMs).toBe(60_000)
  })

  it('reads the knobs and ignores nonsense', () => {
    const config = readConfig({
      PORT: '4000',
      GRID_BFF_JOBS_CONCURRENCY: '5',
      GRID_BFF_JOBS_MAX_PER_ORG: '2',
      GRID_BFF_JOBS_DRAIN_SECONDS: 'soon',
    })

    expect(config.url).toBe('http://127.0.0.1:4000')
    expect(config.runner.concurrency).toBe(5)
    expect(config.runner.perLaneCap).toBe(2)
    expect(config.drainMs).toBe(60_000)
  })

  it('never lets the stale window shrink below a few heartbeats', () => {
    expect(readConfig({ GRID_BFF_JOBS_STALE_SECONDS: '5' }).runner.staleSeconds).toBe(60)
  })

  it('waits for the BFF to answer its health route', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const up = await waitForServer('http://x', { fetchImpl, sleep: () => Promise.resolve(), intervalMs: 0 })

    expect(up).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('gives up when the BFF never answers', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('refused'))

    expect(await waitForServer('http://x', { attempts: 3, fetchImpl, sleep: () => Promise.resolve() })).toBe(false)
  })
})
