/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  schedulesEnabled,
  readConfig,
  createStreaks,
  fireOne,
  reconcileRuns,
  sweepUploads,
  sweepPlacement,
  sweepTraceRetention,
  sweepConversationTraces,
  sweepDownloadLogRetention,
  tick,
  INTERNAL_TOKEN_HEADER,
} from './index.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('schedulesEnabled (the schedules gate)', () => {
  it('is off when neither gate env is set — schedules are not fired', () => {
    expect(schedulesEnabled({})).toBe(false)
    expect(schedulesEnabled({ GRID_SKILLS_ENABLED: 'false' })).toBe(false)
    expect(schedulesEnabled({ GRID_SKILLS_ENABLED: '1' })).toBe(false) // only literal 'true'
  })

  it('starts when the dark-launch opt-in is true', () => {
    expect(schedulesEnabled({ GRID_SKILLS_ENABLED: 'true' })).toBe(true)
  })

  it('starts when feature-flag enforcement is on', () => {
    expect(schedulesEnabled({ GRID_ENFORCE_FEATURE_FLAGS: 'true' })).toBe(true)
  })
})

describe('readConfig', () => {
  it('applies the documented defaults', () => {
    const c = readConfig({})
    expect(c.frontendUrl).toBe('http://frontend:3000')
    expect(c.internalToken).toBe('')
    expect(c.pollMs).toBe(30000)
    expect(c.batch).toBe(20)
    expect(c.retentionDays).toBe(90)
  })

  it('reads the GRID_SKILL_SCHEDULER_* overrides and strips a trailing slash from the frontend URL', () => {
    const c = readConfig({
      FRONTEND_INTERNAL_URL: 'http://frontend:3000/',
      GRID_INTERNAL_API_TOKEN: 'tok',
      GRID_SKILL_SCHEDULER_POLL_MS: '5000',
      GRID_SKILL_SCHEDULER_BATCH: '7',
      GRID_SKILL_RUNS_RETENTION_DAYS: '30',
    })
    expect(c.frontendUrl).toBe('http://frontend:3000')
    expect(c.internalToken).toBe('tok')
    expect(c.pollMs).toBe(5000)
    expect(c.batch).toBe(7)
    expect(c.retentionDays).toBe(30)
  })


  it('prefers the new GRID_SKILL_* name when both new and old are set (no warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = readConfig({
      GRID_SKILL_SCHEDULER_POLL_MS: '1000',
      GRID_WORKFLOW_SCHEDULER_POLL_MS: '9000',
    })
    expect(c.pollMs).toBe(1000)
    expect(warn).not.toHaveBeenCalled()
  })

  it('falls back to defaults for non-positive / garbage numeric knobs', () => {
    const c = readConfig({
      GRID_SKILL_SCHEDULER_POLL_MS: '0',
      GRID_SKILL_SCHEDULER_BATCH: '-3',
      GRID_SKILL_RUNS_RETENTION_DAYS: 'abc',
    })
    expect(c.pollMs).toBe(30000)
    expect(c.batch).toBe(20)
    expect(c.retentionDays).toBe(90)
  })
})

describe('fireOne', () => {
  const config = { frontendUrl: 'http://frontend:3000', internalToken: 'secret-tok' }

  it('POSTs the fire endpoint with the internal-token header and {scheduleId} body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    const ok = await fireOne(config, 'sk-123', fetchImpl)

    expect(ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://frontend:3000/api/internal/skills/fire')
    expect(init.method).toBe('POST')
    expect(init.headers[INTERNAL_TOKEN_HEADER]).toBe('secret-tok')
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ scheduleId: 'sk-123' })
    expect(init.signal).toBeInstanceOf(AbortSignal) // per-request timeout wired
  })

  it('logs loudly and returns false (never throws) on a non-2xx response', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('Internal API disabled'),
    })

    const ok = await fireOne(config, 'sk-err', fetchImpl)

    expect(ok).toBe(false)
    expect(errorLog).toHaveBeenCalledTimes(1)
    const msg = errorLog.mock.calls[0].join(' ')
    expect(msg).toContain('sk-err')
    expect(msg).toContain('503')
    expect(msg).toContain('Internal API disabled')
  })

  it('logs the status of an HTML error page, never the page', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: () => Promise.resolve('<!DOCTYPE html><html><link href="/_next/static/css/ab12.css"/></html>'),
    })

    expect(await fireOne(config, 'sk-404', fetchImpl)).toBe(false)
    const msg = errorLog.mock.calls[0].join(' ')
    expect(msg).toContain('HTTP 404 text/html')
    expect(msg).not.toContain('<')
  })

  it('swallows a transport/timeout error and returns false', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn().mockRejectedValue(new Error('aborted'))

    const ok = await fireOne(config, 'sk-net', fetchImpl)

    expect(ok).toBe(false)
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog.mock.calls[0].join(' ')).toContain('sk-net')
  })

  it('logs a {fired:false} skip as a skip, not a fire', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ fired: false, reason: 'schedule disabled' }),
    })

    const ok = await fireOne(config, 'sk-skip', fetchImpl)

    expect(ok).toBe(false)
    expect(warn.mock.calls[0].join(' ')).toContain('sk-skip')
    expect(warn.mock.calls[0].join(' ')).toContain('schedule disabled')
  })
})

describe('reconcileRuns (the run reconciler’s clock)', () => {
  const config = { frontendUrl: 'http://frontend:3000', internalToken: 'secret-tok', pollMs: 30000 }
  const counts = { checked: 3, closed: 1, alreadyClosed: 0, waiting: 2, failed: 0 }
  const streak = () => createStreaks(config).reconcile

  it('POSTs the BFF sweep with the internal token and returns its counts', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(counts) })

    const result = await reconcileRuns(config, fetchImpl, streak())

    expect(result).toEqual(counts)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://frontend:3000/api/internal/runs/reconcile')
    expect(init.method).toBe('POST')
    expect(init.headers[INTERNAL_TOKEN_HEADER]).toBe('secret-tok')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('says nothing for a sweep that changed nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const quiet = { ...counts, closed: 0 }
    await reconcileRuns(config, vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(quiet) }), streak())
    expect(log).not.toHaveBeenCalled()
  })

  it('reports a sweep that only healed blocks, so the backlog clearing is visible in the log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const healing = { ...counts, closed: 0, healed: 7 }
    await reconcileRuns(config, vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(healing) }), streak())
    expect(log).toHaveBeenCalledWith(expect.stringContaining('healed 7'))
  })

  it('never throws, on a refusal or a transport error', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = vi.fn().mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('Forbidden') })
    expect(await reconcileRuns(config, refused, streak())).toBeNull()
    expect(await reconcileRuns(config, vi.fn().mockRejectedValue(new Error('aborted')), streak())).toBeNull()
    // A 403 is a wrong token, a real fault: ERROR at once. The transport error
    // heals on its own: WARN.
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog.mock.calls[0].join(' ')).toContain('HTTP 403')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('reconcileRuns during a rollout or an outage (#785, #793, #799, #800)', () => {
  const config = { frontendUrl: 'http://frontend:3000', internalToken: 't', pollMs: 30000 }

  /** What an old frontend pod without the route answers mid-rollout. */
  const html404 = () =>
    vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: () =>
        Promise.resolve(
          '<!DOCTYPE html><html><head><link rel="stylesheet" href="/_next/static/css/0f3a1c9b2e7d4a61.css"/>' +
            '<title>404: This page could not be found.</title></head></html>',
        ),
    })
  const fetchFailed = () =>
    vi.fn().mockRejectedValue(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:3000'), { code: 'ECONNREFUSED' }),
      }),
    )
  const unavailable503 = () =>
    vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () =>
        Promise.resolve(
          '{"error":"The database is not reachable right now. Try again shortly.","code":"DATABASE_UNAVAILABLE","requestId":"04c409c2"}',
        ),
    })
  const ok = () => vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ closed: 0, failed: 0 }) })

  function spies() {
    return {
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    }
  }

  it('logs an HTML 404 at WARN, with the status and never the page', async () => {
    const { error, warn } = spies()
    await reconcileRuns(config, html404(), createStreaks(config).reconcile)

    expect(error).not.toHaveBeenCalled()
    const line = warn.mock.calls[0].join(' ')
    expect(line).toContain('HTTP 404 text/html')
    expect(line).not.toContain('<')
    expect(line).not.toContain('_next/static')
  })

  it('logs a refused connection and the BFF’s 503 at WARN', async () => {
    const { error, warn } = spies()
    const { reconcile } = createStreaks(config)
    await reconcileRuns(config, fetchFailed(), reconcile)
    await reconcileRuns(config, unavailable503(), reconcile)

    expect(error).not.toHaveBeenCalled()
    expect(warn.mock.calls[0].join(' ')).toContain('transport error (ECONNREFUSED)')
    expect(warn.mock.calls[1].join(' ')).toContain('HTTP 503 application/json')
    // The non-HTML snippet stays, so the WARN still joins to the BFF's line.
    expect(warn.mock.calls[1].join(' ')).toContain('04c409c2')
  })

  it('escalates to ONE error after ten failed ticks (five minutes at 30 s), and logs the recovery', async () => {
    const { error, warn, log } = spies()
    const { reconcile } = createStreaks(config)

    for (let i = 0; i < 9; i += 1) await reconcileRuns(config, html404(), reconcile)
    expect(error).not.toHaveBeenCalled()

    for (let i = 0; i < 6; i += 1) await reconcileRuns(config, html404(), reconcile)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0].join(' ')).toBe(
      '[job-scheduler] run reconcile still failing after 10 consecutive ticks: HTTP 404 text/html',
    )
    expect(warn).toHaveBeenCalledTimes(14)

    await reconcileRuns(config, ok(), reconcile)
    expect(log).toHaveBeenCalledWith('[job-scheduler] run reconcile recovered after 15 failed ticks')

    // Recovery reset the count: nine more failures are warnings again.
    for (let i = 0; i < 9; i += 1) await reconcileRuns(config, fetchFailed(), reconcile)
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe('tick', () => {
  const base = { frontendUrl: 'http://frontend:3000', internalToken: 't', batch: 20, retentionDays: 90, pollMs: 30000 }
  /**
   * The streaks, with the download log's daily sweep not due. These cases are
   * about the claim and the reconciler, and the sweep also reads the database:
   * left due it would add its own failures to what they count. It has its own
   * cases below.
   */
  const streaksWithoutDownloadLog = () => {
    const streaks = createStreaks(base)
    streaks.downloadLogClock.nextRunAt = Number.POSITIVE_INFINITY
    return streaks
  }
  const reconciled = () => vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ closed: 0, failed: 0 }) })

  it('with the schedules gate off, fires nothing but still reconciles runs and sweeps uploads', async () => {
    // A run exists without Agent Skills (an escalated chat question), so its
    // reconciliation cannot wait on the skills feature; nor can an upload's.
    const sql = { begin: vi.fn() }
    const fetchImpl = reconciled()

    const fired = await tick(sql, { ...base, schedulesEnabled: false }, fetchImpl, streaksWithoutDownloadLog())

    expect(fired).toBe(0)
    expect(sql.begin).not.toHaveBeenCalled()
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://frontend:3000/api/internal/runs/reconcile',
      'http://frontend:3000/api/internal/upload-batches/sweep',
      'http://frontend:3000/api/internal/folder-placement/sweep',
    ])
  })

  it('with the gate on, a failed claim still leaves the reconciler its turn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sql = { begin: vi.fn().mockRejectedValue(new Error('db down')) }
    const fetchImpl = reconciled()

    await tick(sql, { ...base, schedulesEnabled: true }, fetchImpl, streaksWithoutDownloadLog())

    expect(sql.begin).toHaveBeenCalled()
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://frontend:3000/api/internal/runs/reconcile',
      'http://frontend:3000/api/internal/upload-batches/sweep',
      'http://frontend:3000/api/internal/folder-placement/sweep',
    ])
  })

  it('logs a claim the database outage refused at WARN, escalating once after ten ticks (#804)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const down = Object.assign(new Error('connect EHOSTUNREACH 10.111.223.83:5432 - Local (0.0.0.0:0)'), {
      code: 'EHOSTUNREACH',
    })
    const sql = { begin: vi.fn().mockRejectedValue(down) }
    const streaks = streaksWithoutDownloadLog()
    const config = { ...base, schedulesEnabled: true }

    await tick(sql, config, reconciled(), streaks)
    expect(error).not.toHaveBeenCalled()
    expect(warn.mock.calls[0].join(' ')).toContain('[job-scheduler] schedule claim failed (database unavailable (EHOSTUNREACH))')

    for (let i = 0; i < 12; i += 1) await tick(sql, config, reconciled(), streaks)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0].join(' ')).toBe(
      '[job-scheduler] schedule claim still failing after 10 consecutive ticks: database unavailable (EHOSTUNREACH)',
    )

    // The database is back: the claim finds nothing due and the prune runs.
    const healthy = { begin: vi.fn().mockResolvedValue([]) }
    await tick(healthy, config, reconciled(), streaks)
    expect(log).toHaveBeenCalledWith('[job-scheduler] schedule claim recovered after 13 failed ticks')
  })

  it('keeps a claim that failed for any other reason at ERROR', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = Object.assign(new Error('relation "task_definitions" does not exist'), { code: '42P01' })
    await tick({ begin: vi.fn().mockRejectedValue(bad) }, { ...base, schedulesEnabled: true }, reconciled(), streaksWithoutDownloadLog())
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toContain('claim transaction failed')
  })
})

describe('sweepDownloadLogRetention (the download log is purged daily, migration 0110)', () => {
  const NOW = new Date('2026-10-06T12:00:00.000Z')
  const DAY = 24 * 60 * 60 * 1000
  const streak = () => ({ failed: vi.fn(), succeeded: vi.fn() })

  it('purges, then waits a day', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const prune = vi.fn().mockResolvedValue({ deleted: 3, capped: false })
    const clock = { nextRunAt: 0 }
    const s = streak()

    const result = await sweepDownloadLogRetention({}, s, clock, NOW, prune)

    expect(result).toEqual({ deleted: 3, capped: false })
    expect(clock.nextRunAt).toBe(NOW.getTime() + DAY)
    expect(s.succeeded).toHaveBeenCalled()
    expect(log.mock.calls[0][0]).toContain('deleted 3 entries past retention')
  })

  it('does nothing before it is due', async () => {
    const prune = vi.fn()
    const clock = { nextRunAt: NOW.getTime() + 1 }

    expect(await sweepDownloadLogRetention({}, streak(), clock, NOW, prune)).toBeNull()
    expect(prune).not.toHaveBeenCalled()
  })

  it('continues on the next tick when the batch budget ran out with more behind it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const prune = vi.fn().mockResolvedValue({ deleted: 50000, capped: true })
    const clock = { nextRunAt: 0 }

    await sweepDownloadLogRetention({}, streak(), clock, NOW, prune)

    expect(clock.nextRunAt).toBe(NOW.getTime())
    const again = await sweepDownloadLogRetention({}, streak(), clock, new Date(NOW.getTime() + 30_000), prune)
    expect(again).not.toBeNull()
  })

  it('treats a database outage as transient: a WARN streak, tried again on the next tick', async () => {
    const down = Object.assign(new Error('connect EHOSTUNREACH 10.0.0.1:5432'), { code: 'EHOSTUNREACH' })
    const prune = vi.fn().mockRejectedValue(down)
    const clock = { nextRunAt: 0 }
    const s = streak()

    expect(await sweepDownloadLogRetention({}, s, clock, NOW, prune)).toBeNull()

    expect(s.failed).toHaveBeenCalled()
    expect(clock.nextRunAt).toBe(0)
  })

  it('logs any other failure at ERROR and waits an hour', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prune = vi.fn().mockRejectedValue(Object.assign(new Error('permission denied'), { code: '42501' }))
    const clock = { nextRunAt: 0 }

    await sweepDownloadLogRetention({}, streak(), clock, NOW, prune)

    expect(error.mock.calls[0][0]).toContain('download log retention failed')
    expect(clock.nextRunAt).toBe(NOW.getTime() + 60 * 60 * 1000)
  })

  it('runs as part of every tick, through the real purge', async () => {
    const sql = { begin: vi.fn().mockResolvedValue([]) }
    const base = { frontendUrl: 'http://frontend:3000', internalToken: 't', batch: 20, retentionDays: 90, pollMs: 30000 }
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })

    await tick(sql, { ...base, schedulesEnabled: false }, fetchImpl, createStreaks(base))

    // The cap statement and the list of organizations with a shorter setting.
    expect(sql.begin).toHaveBeenCalledTimes(2)
  })
})

describe('sweepUploads (the upload sweep’s clock, ADR-0077)', () => {
  const config = { frontendUrl: 'http://frontend:3000', internalToken: 'tok', pollMs: 30000 }
  const streak = () => ({ failed: vi.fn(), succeeded: vi.fn() })

  it('posts the sweep with the internal token and logs only when it settled something', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const quiet = { checked: 3, sealed: 0, completed: 0, failed: 0 }
    const busy = { checked: 3, sealed: 1, completed: 2, failed: 0 }
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(quiet) })
    expect(await sweepUploads(config, fetchImpl, streak())).toEqual(quiet)
    expect(fetchImpl.mock.calls[0][0]).toBe('http://frontend:3000/api/internal/upload-batches/sweep')
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ [INTERNAL_TOKEN_HEADER]: 'tok' })
    expect(log).not.toHaveBeenCalled()
    await sweepUploads(config, vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(busy) }), streak())
    expect(log.mock.calls[0].join(' ')).toContain('upload sweep: checked 3, sealed 1, completed 2, failed 0')
    log.mockRestore()
  })

  it('treats a transport error as transient and never throws', async () => {
    const s = streak()
    expect(await sweepUploads(config, vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), s)).toBeNull()
    expect(s.failed).toHaveBeenCalled()
  })
})

describe('sweepPlacement (retries a restriction an outage interrupted, ADR-0078)', () => {
  const config = { frontendUrl: 'http://frontend:3000', internalToken: 'tok', pollMs: 30000 }
  const streak = () => ({ failed: vi.fn(), succeeded: vi.fn() })

  it('posts the sweep with the internal token and logs only when something moved or is still pending', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const quiet = { checked: 2, moved: 0, pending: 0, failed: 0 }
    const busy = { checked: 2, moved: 3, pending: 1, failed: 0 }
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(quiet) })
    expect(await sweepPlacement(config, fetchImpl, streak())).toEqual(quiet)
    expect(fetchImpl.mock.calls[0][0]).toBe('http://frontend:3000/api/internal/folder-placement/sweep')
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ [INTERNAL_TOKEN_HEADER]: 'tok' })
    expect(log).not.toHaveBeenCalled()
    await sweepPlacement(config, vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(busy) }), streak())
    expect(log.mock.calls[0].join(' ')).toContain('folder placement sweep: checked 2, moved 3, still pending 1, failed 0')
    log.mockRestore()
  })
})

describe('Langfuse trace retention (ADR-0044)', () => {
  const NOW = new Date('2026-10-06T12:00:00.000Z')
  const DAY = 24 * 60 * 60 * 1000
  const env = {
    LANGFUSE_HOST: 'http://langfuse-web:3000',
    LANGFUSE_PUBLIC_KEY: 'pk-lf-1',
    LANGFUSE_SECRET_KEY: 'sk-lf-2', // pragma: allowlist secret
  }
  const streak = () => ({ failed: vi.fn(), succeeded: vi.fn() })
  const answer = (status, body = {}) => ({ ok: status < 300, status, json: () => Promise.resolve(body) })
  const roots = (n, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ traceId: `t${from + i}`, startTime: '2026-08-01T00:00:00.000Z' }))

  /** A Langfuse with `pages` of old root observations; records the lists and deletes. */
  function langfuse(pages) {
    const lists = []
    const deletes = []
    let served = 0
    const fetchImpl = vi.fn(async (url, init) => {
      if (init.method === 'DELETE') {
        deletes.push(JSON.parse(init.body).traceIds)
        return answer(200, { message: 'ok' })
      }
      lists.push(Object.fromEntries(new URL(url).searchParams))
      const page = pages[served] ?? []
      served += 1
      return answer(200, { data: page, meta: served < pages.length ? { cursor: `c${served}` } : {} })
    })
    return { fetchImpl, lists, deletes }
  }

  describe('readConfig', () => {
    it('keeps retention off without the three Langfuse settings, and defaults the window to 30 days', () => {
      const c = readConfig({})
      expect(c.langfuse).toBeNull()
      expect(c.langfuseMissing).toEqual(['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'])
      expect(c.traceRetentionDays).toBe(30)
    })

    it('reads GRID_LANGFUSE_TRACE_RETENTION_DAYS and never goes below the 3-day minimum', () => {
      expect(readConfig({ ...env, GRID_LANGFUSE_TRACE_RETENTION_DAYS: '14' }).traceRetentionDays).toBe(14)
      expect(readConfig({ ...env, GRID_LANGFUSE_TRACE_RETENTION_DAYS: '1' }).traceRetentionDays).toBe(3)
      expect(readConfig({ ...env, GRID_LANGFUSE_TRACE_RETENTION_DAYS: 'x' }).traceRetentionDays).toBe(30)
      expect(readConfig(env).langfuse.host).toBe('http://langfuse-web:3000')
    })
  })

  describe('sweepTraceRetention', () => {
    it('is a no-op without Langfuse configured: no request, no state change', async () => {
      const fetchImpl = vi.fn()
      const clock = { nextRunAt: 0 }
      expect(await sweepTraceRetention(readConfig({}), fetchImpl, streak(), clock, NOW)).toBeNull()
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(clock.nextRunAt).toBe(0)
    })

    it('deletes traces older than the window: the cutoff is now minus the retention days', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { fetchImpl, lists, deletes } = langfuse([roots(3)])
      const s = streak()

      const result = await sweepTraceRetention(readConfig({ ...env, GRID_LANGFUSE_TRACE_RETENTION_DAYS: '14' }), fetchImpl, s, { nextRunAt: 0 }, NOW)

      expect(result).toEqual({ traces: 3, batches: 1, capped: false })
      expect(lists[0].toStartTime).toBe(new Date(NOW.getTime() - 14 * DAY).toISOString())
      expect(deletes).toEqual([['t0', 't1', 't2']])
      expect(s.succeeded).toHaveBeenCalled()
      expect(log.mock.calls[0].join(' ')).toContain('asked Langfuse to delete 3 trace(s) older than 14 days')
      log.mockRestore()
    })

    it('cuts off 30 days back by default and 3 days back at the very least', async () => {
      const a = langfuse([[]])
      await sweepTraceRetention(readConfig(env), a.fetchImpl, streak(), { nextRunAt: 0 }, NOW)
      expect(a.lists[0].toStartTime).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString())

      const b = langfuse([[]])
      await sweepTraceRetention(readConfig({ ...env, GRID_LANGFUSE_TRACE_RETENTION_DAYS: '0' }), b.fetchImpl, streak(), { nextRunAt: 0 }, NOW)
      // '0' is not a valid window: the default, never "delete everything".
      expect(b.lists[0].toStartTime).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString())

      const c = langfuse([[]])
      await sweepTraceRetention(readConfig({ ...env, GRID_LANGFUSE_TRACE_RETENTION_DAYS: '2' }), c.fetchImpl, streak(), { nextRunAt: 0 }, NOW)
      expect(c.lists[0].toStartTime).toBe(new Date(NOW.getTime() - 3 * DAY).toISOString())
    })

    it('sends at most 50 delete batches per run and continues the next day', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const pages = Array.from({ length: 60 }, (_, i) => roots(1000, i * 1000))
      const { fetchImpl, deletes } = langfuse(pages)
      const clock = { nextRunAt: 0 }

      const result = await sweepTraceRetention(readConfig(env), fetchImpl, streak(), clock, NOW)

      expect(deletes).toHaveLength(50)
      expect(deletes.every((ids) => ids.length === 1000)).toBe(true)
      expect(result).toMatchObject({ traces: 50000, batches: 50, capped: true })
      expect(console.log.mock.calls[0].join(' ')).toContain('more remain')
    })

    it('runs once a day: not again within 24 hours, again after', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { fetchImpl } = langfuse([[], [], []])
      const config = readConfig(env)
      const clock = { nextRunAt: 0 }

      await sweepTraceRetention(config, fetchImpl, streak(), clock, NOW)
      const afterFirst = fetchImpl.mock.calls.length
      await sweepTraceRetention(config, fetchImpl, streak(), clock, new Date(NOW.getTime() + DAY - 1))
      expect(fetchImpl.mock.calls.length).toBe(afterFirst)

      await sweepTraceRetention(config, fetchImpl, streak(), clock, new Date(NOW.getTime() + DAY))
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(afterFirst)
    })

    it('treats a Langfuse outage as transient (WARN streak, never throws) and retries in an hour', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const fetchImpl = vi.fn().mockResolvedValue(answer(503))
      const s = streak()
      const clock = { nextRunAt: 0 }

      expect(await sweepTraceRetention(readConfig(env), fetchImpl, s, clock, NOW)).toBeNull()

      expect(s.failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'HTTP 503' }))
      expect(error).not.toHaveBeenCalled()
      expect(clock.nextRunAt).toBe(NOW.getTime() + 60 * 60 * 1000)
    })

    it('logs a 401 at ERROR at once, without the keys or the host', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const s = streak()

      await sweepTraceRetention(readConfig(env), vi.fn().mockResolvedValue(answer(401)), s, { nextRunAt: 0 }, NOW)

      expect(s.failed).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledTimes(1)
      const line = error.mock.calls[0].join(' ')
      expect(line).toContain('trace retention failed: HTTP 401')
      expect(line).not.toContain('sk-lf')
      expect(line).not.toContain('langfuse-web')
    })

    it('is part of every tick, after the sweeps, and still only the one run a day', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const base = { ...readConfig(env), frontendUrl: 'http://frontend:3000', internalToken: 't', batch: 20, retentionDays: 90, pollMs: 30000, schedulesEnabled: false }
      const lf = langfuse([[]])
      const fetchImpl = vi.fn(async (url, init) =>
        url.startsWith('http://frontend') ? answer(200, {}) : lf.fetchImpl(url, init),
      )
      const streaks = createStreaks(base)

      const sql = { begin: vi.fn().mockResolvedValue([]) }
      await tick(sql, base, fetchImpl, streaks)
      await tick(sql, base, fetchImpl, streaks)

      expect(lf.lists).toHaveLength(1)
      // The schedules gate is off, so the readers are the sweep of chats the BFF
      // erased (one read a tick, two ticks) and the download log's daily purge
      // (two statements, on the first tick only).
      expect(sql.begin).toHaveBeenCalledTimes(4)
    })
  })
})

describe('sweepConversationTraces (chats the BFF erased in the delete request)', () => {
  const NOW = new Date('2026-10-06T12:00:00.000Z')
  const env = {
    LANGFUSE_HOST: 'http://langfuse-web:3000',
    LANGFUSE_PUBLIC_KEY: 'pk-lf-1',
    LANGFUSE_SECRET_KEY: 'sk-lf-2', // pragma: allowlist secret
  }
  const streak = () => ({ failed: vi.fn(), succeeded: vi.fn() })
  const answer = (status, body = {}) => ({ ok: status < 300, status, json: () => Promise.resolve(body) })
  const row = (n) => ({ id: `q${n}`, entity_id: `s_${n}`, organization_id: 'org_1' })

  /** Langfuse with one trace per session id; records lists and deletes. */
  function langfuse({ failWith } = {}) {
    const lists = []
    const deletes = []
    const fetchImpl = vi.fn(async (url, init) => {
      if (failWith) return answer(failWith)
      if (init.method === 'DELETE') {
        deletes.push(JSON.parse(init.body).traceIds)
        return answer(200, { message: 'ok' })
      }
      const sessionId = new URL(url).searchParams.get('sessionId')
      lists.push(sessionId)
      return answer(200, { data: [{ traceId: `trace-of-${sessionId}`, sessionId }], meta: {} })
    })
    return { fetchImpl, lists, deletes }
  }

  const storeOf = ({ rows = [], held = () => false } = {}) => ({
    candidates: vi.fn().mockResolvedValue(rows),
    held: vi.fn(async (_sql, r) => held(r)),
    markErased: vi.fn().mockResolvedValue(undefined),
  })

  it('is a no-op without Langfuse configured: it does not even read the queue', async () => {
    const store = storeOf({ rows: [row(1)] })
    const { fetchImpl } = langfuse()
    const result = await sweepConversationTraces({}, readConfig({}), fetchImpl, streak(), { nextRunAt: 0 }, NOW, store)
    expect(result).toBeNull()
    expect(store.candidates).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('deletes each erased chat’s traces by its conversation id and stamps its queue row', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const store = storeOf({ rows: [row(1), row(2)] })
    const { fetchImpl, lists, deletes } = langfuse()
    const s = streak()

    const result = await sweepConversationTraces({}, readConfig(env), fetchImpl, s, { nextRunAt: 0 }, NOW, store)

    expect(result).toBe(2)
    expect(lists).toEqual(['s_1', 's_2'])
    expect(deletes).toEqual([['trace-of-s_1'], ['trace-of-s_2']])
    expect(store.markErased.mock.calls.map(([, id]) => id)).toEqual(['q1', 'q2'])
    expect(s.succeeded).toHaveBeenCalled()
  })

  it('leaves a conversation under a legal hold alone: no deletion, no stamp, and the rest go on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const store = storeOf({ rows: [row(1), row(2)], held: (r) => r.entity_id === 's_1' })
    const { fetchImpl, lists, deletes } = langfuse()

    const result = await sweepConversationTraces({}, readConfig(env), fetchImpl, streak(), { nextRunAt: 0 }, NOW, store)

    expect(result).toBe(1)
    expect(lists).toEqual(['s_2'])
    expect(deletes).toEqual([['trace-of-s_2']])
    expect(store.markErased.mock.calls.map(([, id]) => id)).toEqual(['q2'])
  })

  it('on a Langfuse 503 stops the run, stamps nothing, WARNs through the streak and retries on the next tick', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = storeOf({ rows: [row(1), row(2)] })
    const s = streak()
    const clock = { nextRunAt: 0 }

    const result = await sweepConversationTraces({}, readConfig(env), langfuse({ failWith: 503 }).fetchImpl, s, clock, NOW, store)

    expect(result).toBeNull()
    expect(store.markErased).not.toHaveBeenCalled()
    expect(s.failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'HTTP 503' }))
    expect(error).not.toHaveBeenCalled()
    expect(clock.nextRunAt).toBe(0)
  })

  it('treats a 429 as transient too', async () => {
    const s = streak()
    await sweepConversationTraces({}, readConfig(env), langfuse({ failWith: 429 }).fetchImpl, s, { nextRunAt: 0 }, NOW, storeOf({ rows: [row(1)] }))
    expect(s.failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'HTTP 429' }))
  })

  it('logs a 401 at ERROR without ids or keys and backs off for an hour', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = streak()
    const clock = { nextRunAt: 0 }

    await sweepConversationTraces({}, readConfig(env), langfuse({ failWith: 401 }).fetchImpl, s, clock, NOW, storeOf({ rows: [row(1)] }))

    expect(s.failed).not.toHaveBeenCalled()
    const line = error.mock.calls[0].join(' ')
    expect(line).toContain('conversation trace erasure failed: HTTP 401')
    expect(line).not.toContain('s_1')
    expect(line).not.toContain('sk-lf')
    expect(clock.nextRunAt).toBe(NOW.getTime() + 60 * 60 * 1000)

    // Backed off: the next tick does not even read the queue.
    const store = storeOf({ rows: [row(1)] })
    await sweepConversationTraces({}, readConfig(env), langfuse().fetchImpl, s, clock, new Date(NOW.getTime() + 1000), store)
    expect(store.candidates).not.toHaveBeenCalled()
  })

  it('treats a database outage as transient', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const store = storeOf()
    store.candidates.mockRejectedValue(down)
    const s = streak()
    await sweepConversationTraces({}, readConfig(env), langfuse().fetchImpl, s, { nextRunAt: 0 }, NOW, store)
    expect(s.failed).toHaveBeenCalledWith(expect.objectContaining({ kind: expect.stringContaining('database unavailable') }))
  })

  it('asks for at most 100 chats per run', async () => {
    const store = storeOf()
    await sweepConversationTraces({}, readConfig(env), langfuse().fetchImpl, streak(), { nextRunAt: 0 }, NOW, store)
    expect(store.candidates).toHaveBeenCalledWith({}, 100)
  })

  it('runs on every tick (it is not a daily job): a second tick reads the queue again', async () => {
    const store = storeOf()
    const config = readConfig(env)
    const clock = { nextRunAt: 0 }
    await sweepConversationTraces({}, config, langfuse().fetchImpl, streak(), clock, NOW, store)
    await sweepConversationTraces({}, config, langfuse().fetchImpl, streak(), clock, new Date(NOW.getTime() + 30_000), store)
    expect(store.candidates).toHaveBeenCalledTimes(2)
  })
})
