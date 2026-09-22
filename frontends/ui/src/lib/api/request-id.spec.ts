/**
 * The id a user quotes and an operator greps.
 *
 * Two properties carry the whole feature, and both are easy to break without
 * noticing: the id must be the SAME on the header, in the body and in the log
 * line for one request, and the short form must be a literal PREFIX of the long
 * one — a digest would look identical on screen and find nothing.
 */

import { describe, expect, it, vi } from 'vitest'
import { REQUEST_ID_HEADER, resolveRequestId, shortRequestId } from './request-id'
import { errorResponse } from './handler'
import { BadRequestError, TooManyRequestsError } from './errors'

const makeRequest = (headers: Record<string, string> = {}): Request =>
  new Request('https://piloti.test/api/documents/doc_1', { headers })

describe('resolveRequestId', () => {
  it('mints one id per request and keeps handing back the same one', () => {
    const request = makeRequest()

    const first = resolveRequestId(request)

    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(resolveRequestId(request)).toBe(first)
  })

  it('gives two requests two ids', () => {
    expect(resolveRequestId(makeRequest())).not.toBe(resolveRequestId(makeRequest()))
  })

  it('adopts an inbound x-request-id so one id spans every hop', () => {
    const request = makeRequest({ 'x-request-id': 'edge-7f3a91c2' })

    expect(resolveRequestId(request)).toBe('edge-7f3a91c2')
  })

  it('adopts x-correlation-id when that is what the proxy stamps', () => {
    expect(resolveRequestId(makeRequest({ 'x-correlation-id': 'corr-4419aa02' }))).toBe(
      'corr-4419aa02',
    )
  })

  it('refuses an inbound id that would forge a log line or inject a header', () => {
    // The id is printed into a log line and written into a response header, so
    // an unbounded caller-controlled string is a real surface, not a nicety.
    const forged = makeRequest({ 'x-request-id': 'abc\r\nX-Admin: true' })

    const id = resolveRequestId(forged)

    expect(id).not.toContain('\n')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses an id that is too short to be one, and one that is absurdly long', () => {
    expect(resolveRequestId(makeRequest({ 'x-request-id': 'abc' }))).toMatch(/^[0-9a-f-]{36}$/)
    expect(resolveRequestId(makeRequest({ 'x-request-id': 'a'.repeat(500) }))).toMatch(
      /^[0-9a-f-]{36}$/,
    )
  })
})

describe('shortRequestId', () => {
  it('is a literal prefix, so grepping what the user read aloud finds the log line', () => {
    const id = '3f2a1b4c-9d8e-4f70-bc21-0a5d6e7f8091'

    expect(shortRequestId(id)).toBe('3f2a1b4c')
    expect(id.startsWith(shortRequestId(id))).toBe(true)
  })
})

describe('errorResponse', () => {
  it('puts the id in the body and in the header, and they are the same id', async () => {
    const request = makeRequest()

    const response = errorResponse(new BadRequestError('from and to are required'), request)
    const body = (await response.json()) as { requestId?: string; code?: string }

    expect(response.status).toBe(400)
    expect(body.code).toBe('BAD_REQUEST')
    expect(body.requestId).toBe(resolveRequestId(request))
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(body.requestId)
  })

  it('logs the same id it returned, so the two ends of the handshake meet', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const request = makeRequest()

    const response = errorResponse(new Error('boom'), request)
    const body = (await response.json()) as { requestId?: string }

    expect(response.status).toBe(500)
    expect(error.mock.calls[0]?.[0]).toContain(`requestId=${body.requestId}`)
    error.mockRestore()
  })

  it('keeps the rate-limit headers a 429 needs while adding its own', async () => {
    const request = makeRequest()
    const decision = {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: Date.now() + 1000,
      retryAfterSeconds: 30,
    }

    const response = errorResponse(
      new TooManyRequestsError(decision as unknown as TooManyRequestsError['decision']),
      request,
    )

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBeTruthy()
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy()
  })

  it('echoes the caller’s own id rather than replacing it', async () => {
    const response = errorResponse(
      new BadRequestError('nope'),
      makeRequest({ 'x-request-id': 'edge-7f3a91c2' }),
    )

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('edge-7f3a91c2')
    expect(((await response.json()) as { requestId?: string }).requestId).toBe('edge-7f3a91c2')
  })
})
