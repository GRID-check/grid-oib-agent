/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))
vi.mock('server-only', () => ({}))

import { errorResponse } from './handler'

describe('errorResponse', () => {
  it('turns a postgres invalid-uuid failure into a 404, not a 500 (#572)', () => {
    const error = Object.assign(new Error('Failed query: select ... from "documents"'), {
      cause: Object.assign(new Error('invalid input syntax for type uuid: "HdB-Hamm.jpg"'), {
        code: '22P02',
      }),
    })

    const response = errorResponse(error, new Request('https://grid.test/api/documents/HdB-Hamm.jpg/status'))

    expect(response.status).toBe(404)
  })

  it('logs the postgres code beside an unhandled database failure (#581)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = Object.assign(new Error('Failed query: update "messages" set "metadata" = $1'), {
        cause: Object.assign(new Error('invalid byte sequence'), { code: '22021' }),
      })

      const response = errorResponse(error, new Request('https://grid.test/api/conversations/c1/messages/m1'))

      expect(response.status).toBe(500)
      expect(spy).toHaveBeenCalledOnce()
      expect(String(spy.mock.calls[0][0])).toContain('pgCode=22021')
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the log line unchanged when there is no postgres code', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = errorResponse(new Error('boom'), new Request('https://grid.test/api/things'))

      expect(response.status).toBe(500)
      expect(String(spy.mock.calls[0][0])).not.toContain('pgCode=')
    } finally {
      spy.mockRestore()
    }
  })

  // The two shapes the 2026-09-25 restart produced (#733-#741), exactly as
  // Drizzle wrapped them: a socket errno, and Postgres refusing new sessions.
  it.each([
    ['EHOSTUNREACH', Object.assign(new Error('connect EHOSTUNREACH 10.111.223.83:5432'), { code: 'EHOSTUNREACH', errno: -113 })],
    ['57P03', Object.assign(new Error('the database system is shutting down'), { code: '57P03', severity: 'FATAL' })],
    ['CONNECTION_CLOSED', Object.assign(new Error('write CONNECTION_CLOSED db:5432'), { code: 'CONNECTION_CLOSED' })],
  ])('answers an unreachable database (%s) with a 503 and one fixed log line', async (code, cause) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = Object.assign(new Error('Failed query: select "prefs" from "user_preferences"'), { cause })

      const response = errorResponse(error, new Request('https://grid.test/api/user/preferences'))

      expect(response.status).toBe(503)
      expect(response.headers.get('Retry-After')).toBe('5')
      expect((await response.json()).code).toBe('DATABASE_UNAVAILABLE')
      expect(spy).toHaveBeenCalledOnce()
      const line = String(spy.mock.calls[0][0])
      expect(line).toMatch(new RegExp(`^\\[db\\] database unavailable \\(${code}\\) requestId=`))
      // The path is what split one outage into nine issues; it stays out.
      expect(line).not.toContain('/api/user/preferences')
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps a query the database rejected as a 500', () => {
    // 23505 is a bug in the caller, not an outage.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = Object.assign(new Error('Failed query: insert'), {
        cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
      })
      expect(errorResponse(error, new Request('https://grid.test/api/things')).status).toBe(500)
    } finally {
      spy.mockRestore()
    }
  })
})
