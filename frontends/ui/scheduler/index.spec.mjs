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
  drainInboundMail,
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

describe('drainInboundMail (the mail drain\u2019s clock)', () => {
  const config = { frontendUrl: 'http://frontend:3000', internalToken: 'secret-tok', pollMs: 30000 }
  const counts = { reaped: 0, filed: 2, retried: 1, failed: 0, held: 0, lost: 0, stagingExpired: 0, deleted: 3 }
  const streak = () => createStreaks(config).drain

  it('POSTs the BFF drain with the internal token and returns its counts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(counts) })

    expect(await drainInboundMail(config, fetchImpl, streak())).toEqual(counts)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://frontend:3000/api/internal/inbound-mail/drain')
    expect(init.method).toBe('POST')
    expect(init.headers[INTERNAL_TOKEN_HEADER]).toBe('secret-tok')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('mail drain: filed 2, retried 1, failed 0'))
  })

  it('says nothing for a pass that filed nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const quiet = { ...counts, filed: 0 }
    await drainInboundMail(config, vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(quiet) }), streak())
    expect(log).not.toHaveBeenCalled()
  })

  it('never throws: a wrong token is an ERROR at once, a transport error a WARN', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('Unauthorized') })
    expect(await drainInboundMail(config, refused, streak())).toBeNull()
    expect(await drainInboundMail(config, vi.fn().mockRejectedValue(new Error('aborted')), streak())).toBeNull()
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog.mock.calls[0].join(' ')).toContain('mail drain failed: HTTP 401')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps its own failure streak, apart from the reconciler\u2019s', () => {
    const streaks = createStreaks(config)
    expect(streaks.drain).toBeDefined()
    expect(streaks.drain).not.toBe(streaks.reconcile)
  })
})

describe('tick', () => {
  const base = { frontendUrl: 'http://frontend:3000', internalToken: 't', batch: 20, retentionDays: 90, pollMs: 30000 }
  const reconciled = () => vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ closed: 0, failed: 0 }) })

  it('with the schedules gate off, fires nothing but still reconciles runs and drains mail', async () => {
    // A run exists without Agent Skills (an escalated chat question), so its
    // reconciliation cannot wait on the skills feature; nor can the mail
    // inbox, which is switched per organization inside the BFF.
    const sql = { begin: vi.fn() }
    const fetchImpl = reconciled()

    const fired = await tick(sql, { ...base, schedulesEnabled: false }, fetchImpl, createStreaks(base))

    expect(fired).toBe(0)
    expect(sql.begin).not.toHaveBeenCalled()
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://frontend:3000/api/internal/runs/reconcile',
      'http://frontend:3000/api/internal/inbound-mail/drain',
    ])
  })

  it('drains mail even when the reconcile POST failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('aborted'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ filed: 0, failed: 0 }) })

    await tick({ begin: vi.fn() }, { ...base, schedulesEnabled: false }, fetchImpl, createStreaks(base))

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://frontend:3000/api/internal/runs/reconcile',
      'http://frontend:3000/api/internal/inbound-mail/drain',
    ])
  })

  it('with the gate on, a failed claim still leaves the reconciler its turn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sql = { begin: vi.fn().mockRejectedValue(new Error('db down')) }
    const fetchImpl = reconciled()

    await tick(sql, { ...base, schedulesEnabled: true }, fetchImpl, createStreaks(base))

    expect(sql.begin).toHaveBeenCalled()
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://frontend:3000/api/internal/runs/reconcile',
      'http://frontend:3000/api/internal/inbound-mail/drain',
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
    const streaks = createStreaks(base)
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
    await tick({ begin: vi.fn().mockRejectedValue(bad) }, { ...base, schedulesEnabled: true }, reconciled(), createStreaks(base))
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toContain('claim transaction failed')
  })
})
