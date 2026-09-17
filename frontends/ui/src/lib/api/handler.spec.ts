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
})
