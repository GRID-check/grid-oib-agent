/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldStart, readConfig, fireOne, reconcileRegister, tick, INTERNAL_TOKEN_HEADER } from './index.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const NEW_NAMES = {
  pollMs: 'GRID_SKILL_SCHEDULER_POLL_MS',
  batch: 'GRID_SKILL_SCHEDULER_BATCH',
  retentionDays: 'GRID_SKILL_RUNS_RETENTION_DAYS',
}
const OLD_NAMES = {
  pollMs: 'GRID_WORKFLOW_SCHEDULER_POLL_MS',
  batch: 'GRID_WORKFLOW_SCHEDULER_BATCH',
  retentionDays: 'GRID_WORKFLOW_RUNS_RETENTION_DAYS',
}

describe('shouldStart (deployment start gate)', () => {
  it('is off when neither gate env is set — the container no-ops', () => {
    expect(shouldStart({})).toBe(false)
    expect(shouldStart({ GRID_SKILLS_ENABLED: 'false' })).toBe(false)
    expect(shouldStart({ GRID_SKILLS_ENABLED: '1' })).toBe(false) // only literal 'true'
  })

  it('starts when the dark-launch opt-in is true', () => {
    expect(shouldStart({ GRID_SKILLS_ENABLED: 'true' })).toBe(true)
  })

  it('starts when feature-flag enforcement is on', () => {
    expect(shouldStart({ GRID_ENFORCE_FEATURE_FLAGS: 'true' })).toBe(true)
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

describe('reconcileRegister (the Projektregister stage)', () => {
  const config = { frontendUrl: 'http://frontend:3000', internalToken: 'tok' }

  it('posts to the internal reconcile route with the shared token', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ rebuilt: 3 }) }))
    expect(await reconcileRegister(config, fetchImpl)).toBe(3)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://frontend:3000/api/internal/workspace/register/reconcile')
    expect(init.method).toBe('POST')
    expect(init.headers[INTERNAL_TOKEN_HEADER]).toBe('tok')
  })

  it('swallows a non-2xx rather than throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }))
    await expect(reconcileRegister(config, fetchImpl)).resolves.toBe(0)
  })

  it('swallows a transport error rather than throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(reconcileRegister(config, fetchImpl)).resolves.toBe(0)
  })
})

describe('tick (stage isolation)', () => {
  // Same fake-sql idiom as db.spec.mjs: a tagged template that answers SELECTs
  // with the claim rows and everything else with nothing.
  function makeSql(selectRows) {
    const tx = (strings) => {
      const text = strings.join('$').replace(/\s+/g, ' ').trim()
      return Promise.resolve(/^SELECT/i.test(text) ? selectRows : [])
    }
    tx.unsafe = () => Promise.resolve([])
    return { begin: (cb) => cb(tx) }
  }

  it('fires the claimed jobs even when the register reconcile fails', async () => {
    // The whole reason the stage is last and defended: a register outage costs
    // the Büro a stale Steckbrief, never the deployment its scheduled jobs.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fired = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/workspace/register/reconcile')) throw new Error('register down')
      fired.push(String(url))
      return { ok: true, json: async () => ({ fired: true }) }
    })

    const sql = makeSql([{ id: 'job-1', schedule_cron: '0 9 * * *', schedule_timezone: 'UTC' }])
    const config = {
      frontendUrl: 'http://frontend:3000',
      internalToken: 'tok',
      batch: 20,
      retentionDays: 90,
    }

    await expect(tick(sql, config)).resolves.toBe(1)
    expect(fired).toEqual(['http://frontend:3000/api/internal/skills/fire'])
  })
})
