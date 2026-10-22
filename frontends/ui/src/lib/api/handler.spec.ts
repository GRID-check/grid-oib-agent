/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))
vi.mock('server-only', () => ({}))

import { errorResponse, internalApiRoute, SIGNED_INTERNAL_PREFIX } from './handler'
import { readBoundedBody } from './bounded-body'
import { NotFoundError, UpstreamError } from './errors'
import { signedRequest, TEST_KEY_ID, TEST_SIGNING_SECRET, type SignedRequestOptions } from '@/test-utils/signed-request'

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

  it('answers the legal-hold delete trigger (GLH01) with the same 409 the service check gives', async () => {
    // Migration 0093's backstop: a delete path that forgot to ask the hold gate
    // still reaches the trigger, and the refusal must read as a hold, not a 500.
    const error = Object.assign(new Error('Failed query: delete from "documents"'), {
      cause: Object.assign(new Error('legal hold: document d1 is covered by an active legal hold'), {
        code: 'GLH01',
      }),
    })

    const response = errorResponse(error, new Request('https://grid.test/api/documents/d1', { method: 'DELETE' }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'legal_hold' },
    })
  })

  it('answers an insert into a closed project (GPC01) as the 403 the permission check gives (ADR-0090)', async () => {
    const error = Object.assign(new Error('Failed query: insert into "documents"'), {
      cause: Object.assign(new Error('project p1 is closed; nothing may be added to it'), { code: 'GPC01' }),
    })
    const response = errorResponse(error, new Request('https://grid.test/api/documents', { method: 'POST' }))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'project-closed' } })
  })

  it('answers a write into a deleted folder (GFD01) as the folder being gone', async () => {
    // Migration 0115: a folder went to the Papierkorb between the write check and the insert.
    const error = Object.assign(new Error('Failed query: insert into "documents"'), {
      cause: Object.assign(new Error('folder f1 is deleted; nothing may be filed into it'), { code: 'GFD01' }),
    })

    const response = errorResponse(error, new Request('https://grid.test/api/documents', { method: 'POST' }))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND', details: { reason: 'folder_deleted' } })
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

  it('logs an upstream failure, with the store code, and keeps the path out of the line', async () => {
    // 2026-10-20: SeaweedFS out of volume slots refused every new organization's
    // first upload, and the 502 reached the user without a line in any log.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = new UpstreamError('Object storage is unavailable', {
        operation: 'ensureTenantBucket',
        code: 'InternalError',
      })

      const response = errorResponse(error, new Request('https://grid.test/api/archiv/documents/upload'))

      expect(response.status).toBe(502)
      expect(spy).toHaveBeenCalledOnce()
      const line = String(spy.mock.calls[0][0])
      expect(line).toMatch(
        /^\[upstream\] Object storage is unavailable operation=ensureTenantBucket code=InternalError requestId=/,
      )
      expect(line).not.toContain('/api/archiv')
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps an answer about the request out of the error log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(errorResponse(new NotFoundError(), new Request('https://grid.test/api/things/t1')).status).toBe(404)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

/**
 * The signed-route contract end to end, through the factory: a route under
 * `/api/internal/signed/` whose requests are signed by the maintained library
 * (the oracle), and whose handler reads the body held to what the signature
 * vouches for. This is the shape the inbound-mail webhook takes.
 */
describe('internalApiRoute with a signature', () => {
  const NOW = new Date('2026-10-22T12:00:00Z')
  const URL_SIGNED = `https://app.piloti.test${SIGNED_INTERNAL_PREFIX}probe`
  const BODY = 'From: statik@example.test\r\n\r\nPlan anbei'
  const ENVELOPE = { 'x-envelope-to': 'p.abc@piloti.test' }

  const POST = internalApiRoute(
    'Signed probe',
    async ({ request, signature }) => {
      const body = await readBoundedBody(request, {
        expectedLength: signature.contentLength,
        maxBytes: 1024,
        contentDigest: signature.contentDigest,
      })
      return { keyId: signature.keyId, bytes: body.byteLength }
    },
    {
      auth: { signature: { keysEnv: 'GRID_INBOUND_MAIL_SIGNING_KEYS', components: ['x-envelope-to'] } },
      tenancy: { fromPayload: 'the probe touches no tenant data' },
    },
  )

  const sign = (overrides: Partial<SignedRequestOptions> = {}) =>
    signedRequest({ url: URL_SIGNED, body: BODY, created: NOW, headers: ENVELOPE, ...overrides })

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubEnv('GRID_INBOUND_MAIL_SIGNING_KEYS', JSON.stringify({ [TEST_KEY_ID]: TEST_SIGNING_SECRET }))
    vi.stubEnv('WORKOS_REDIRECT_URI', '')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('runs the handler for a request the library signed, with the signature in its context', async () => {
    const response = await POST(await sign())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ keyId: TEST_KEY_ID, bytes: Buffer.byteLength(BODY) })
  })

  it.each([
    ['an expired signature', { created: new Date(NOW.getTime() - 600_000) }, 'expired'],
    ['a keyid the key map does not hold', { keyId: 'unknown-2026-01' }, 'unknown-key'],
    ['a signature by another secret', { secret: Buffer.alloc(32, 1).toString('base64') }, 'bad-signature'],
  ] as const)('answers %s with 401 and never runs the handler', async (_, overrides, reason) => {
    const handler = vi.fn()
    const route = internalApiRoute('Signed probe', handler, {
      auth: { signature: { keysEnv: 'GRID_INBOUND_MAIL_SIGNING_KEYS' } },
      tenancy: { fromPayload: 'none' },
    })

    const response = await route(await sign(overrides))

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED', details: { reason } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('answers a body that does not match the signed digest with 401 bad-digest', async () => {
    const tampered = BODY.replace('Plan', 'Plon')
    const response = await POST(await sign({ sentBody: tampered }))

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ details: { reason: 'bad-digest' } })
  })

  it('answers a body shorter than the signed length with 503 body-truncated, for the sender to retry', async () => {
    const response = await POST(await sign({ sentBody: BODY.slice(0, 12) }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ details: { reason: 'body-truncated' } })
  })

  it('refuses to serve a signed route declared outside the signed prefix', async () => {
    const response = await POST(await sign({ url: 'https://app.piloti.test/api/internal/probe' }))

    expect(response.status).toBe(500)
  })

  it('answers 503 when the key map is not configured', async () => {
    vi.stubEnv('GRID_INBOUND_MAIL_SIGNING_KEYS', '')
    expect((await POST(await sign())).status).toBe(503)
  })

  it('leaves token-guarded routes as they were: no token, 403', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'a-real-token')
    const handler = vi.fn()
    const route = internalApiRoute('Token probe', handler, { tenancy: { fromPayload: 'none' } })

    const response = await route(await sign())

    expect(response.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })
})
