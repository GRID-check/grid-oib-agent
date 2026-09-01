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

  it('states the postgres cause before the query that carried it', () => {
    // The reports for #576, #579 and #581 all arrived truncated in the same
    // place: a failed drizzle query writes its SQL and every bound parameter
    // into its own message, and the metadata of a chat message is kilobytes of
    // it, so the capture kept the parameters and cut the SQLSTATE off the end.
    // The log line has to say what went wrong before it says what was sent.
    const error = Object.assign(
      new Error(`Failed query: update "messages" set "metadata" = $1\nparams: ${'x'.repeat(5000)}`),
      {
        cause: Object.assign(new Error('value too long for type character varying(64)'), {
          code: '22001',
        }),
      }
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    errorResponse(error, new Request('https://grid.test/api/conversations/s_1/messages/m_1'))

    const line = String(logged.mock.calls[0]?.[0])
    expect(line).toContain('22001')
    expect(line).toContain('value too long')
    // Short enough to survive any capture that keeps the head of an entry.
    expect(line.length).toBeLessThan(600)
    logged.mockRestore()
  })
})
