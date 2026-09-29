/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createFailureStreak,
  databaseOutage,
  describeFailedResponse,
  describeTransportError,
  escalationTicks,
} from './failure-streak.js'

function recordingLog() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** The body an old frontend pod answered the reconcile POST with (#785, #793), abridged. */
const NEXT_404_PAGE =
  '<!DOCTYPE html><html lang="de"><head><meta charSet="utf-8"/>' +
  '<link rel="stylesheet" href="/_next/static/css/0f3a1c9b2e7d4a61.css" data-precedence="next"/>' +
  '<title>404: This page could not be found.</title></head><body>…</body></html>'

function response(status, body, contentType) {
  return {
    ok: false,
    status,
    headers: new Headers(contentType ? { 'content-type': contentType } : {}),
    text: () => Promise.resolve(body),
  }
}

describe('escalationTicks', () => {
  it('spans about five minutes at the poll interval', () => {
    expect(escalationTicks(30000)).toBe(10) // the scheduler's default
    expect(escalationTicks(60000)).toBe(5) // the purger's default
  })

  it('never escalates on fewer than three ticks', () => {
    expect(escalationTicks(10 * 60 * 1000)).toBe(3)
    expect(escalationTicks(NaN)).toBe(3)
  })
})

describe('createFailureStreak', () => {
  it('warns on each failed tick, and on the Nth logs exactly one ERROR', () => {
    const log = recordingLog()
    const streak = createFailureStreak({ label: '[job-scheduler] run reconcile', escalateAfter: 3, log })

    for (let i = 0; i < 7; i += 1) streak.failed({ kind: 'HTTP 503 application/json', detail: 'requestId=x' })

    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(
      '[job-scheduler] run reconcile still failing after 3 consecutive ticks: HTTP 503 application/json',
    )
    expect(log.warn).toHaveBeenCalledTimes(6)
    expect(log.warn.mock.calls[0][0]).toContain('[1 in a row]')
    expect(log.warn.mock.calls[0][0]).toContain('requestId=x')
  })

  it('logs one recovery line when a failed streak ends, and resets', () => {
    const log = recordingLog()
    const streak = createFailureStreak({ label: '[purger] queue', escalateAfter: 3, log })

    streak.failed({ kind: 'database unavailable (57P03)' })
    streak.failed({ kind: 'database unavailable (57P03)' })
    streak.succeeded()
    streak.succeeded()

    expect(log.log).toHaveBeenCalledTimes(1)
    expect(log.log).toHaveBeenCalledWith('[purger] queue recovered after 2 failed ticks')
    expect(streak.count()).toBe(0)

    // A new streak counts from zero: two more failures do not reach 3.
    streak.failed({ kind: 'database unavailable (57P03)' })
    streak.failed({ kind: 'database unavailable (57P03)' })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('escalates again after a recovery, once per streak', () => {
    const log = recordingLog()
    const streak = createFailureStreak({ label: '[purger] queue', escalateAfter: 2, log })
    for (let i = 0; i < 3; i += 1) streak.failed({ kind: 'k' })
    streak.succeeded()
    for (let i = 0; i < 3; i += 1) streak.failed({ kind: 'k' })
    expect(log.error).toHaveBeenCalledTimes(2)
  })

  it('says nothing for a success that ended no streak', () => {
    const log = recordingLog()
    createFailureStreak({ label: 'x', escalateAfter: 3, log }).succeeded()
    expect(log.log).not.toHaveBeenCalled()
  })
})

describe('describeFailedResponse', () => {
  it('never carries an HTML body: status and media type only', async () => {
    const described = await describeFailedResponse(response(404, NEXT_404_PAGE, 'text/html; charset=utf-8'))
    expect(described).toEqual({ kind: 'HTTP 404 text/html', detail: 'HTTP 404 text/html' })
  })

  it('recognises an HTML page served without its content type', async () => {
    const described = await describeFailedResponse(response(404, `\n  ${NEXT_404_PAGE}`))
    expect(described.detail).toBe('HTTP 404')
  })

  it('keeps a short snippet of a non-HTML body for the warning', async () => {
    const body = JSON.stringify({ error: 'The database is not reachable right now.', code: 'DATABASE_UNAVAILABLE' })
    const described = await describeFailedResponse(response(503, body, 'application/json'))
    expect(described.kind).toBe('HTTP 503 application/json')
    expect(described.detail).toContain('DATABASE_UNAVAILABLE')
  })

  it('bounds the snippet', async () => {
    const described = await describeFailedResponse(response(500, 'x'.repeat(5000), 'text/plain'))
    expect(described.detail.length).toBeLessThan(250)
  })

  it('works without headers or a readable body', async () => {
    expect(await describeFailedResponse({ status: 502 })).toEqual({ kind: 'HTTP 502', detail: 'HTTP 502' })
    const unreadable = { status: 500, text: () => Promise.reject(new Error('socket hang up')) }
    expect((await describeFailedResponse(unreadable)).detail).toBe('HTTP 500')
  })
})

describe('describeTransportError', () => {
  it('names the socket code undici hangs on cause', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3000'), { code: 'ECONNREFUSED' }),
    })
    expect(describeTransportError(error)).toEqual({ kind: 'transport error (ECONNREFUSED)', detail: 'fetch failed' })
  })

  it('falls back to the error name (a timeout abort)', () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    expect(describeTransportError(abort).kind).toBe('transport error (AbortError)')
  })
})

describe('databaseOutage', () => {
  it('is a failure for an unreachable database, undefined for anything else', () => {
    const down = Object.assign(new Error('connect EHOSTUNREACH 10.111.223.83:5432'), { code: 'EHOSTUNREACH' })
    expect(databaseOutage(down)).toEqual({ kind: 'database unavailable (EHOSTUNREACH)', detail: down.message })
    expect(databaseOutage(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }))).toBeUndefined()
  })
})
