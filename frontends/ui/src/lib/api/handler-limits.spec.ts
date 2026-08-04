/**
 * The route factory's rate-limit behaviour (ADR-0040 L2).
 *
 * The contract worth pinning is the DEFAULT, because that is what protects
 * routes nobody thought about: a mutating method is bounded even when its
 * author never mentioned limits, a read is not, and a route may opt out only by
 * saying so. Everything else about limiting is covered in
 * `@/lib/limits/enforce.spec`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requireAuthorizedSession = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: () => requireAuthorizedSession(),
}))
vi.mock('server-only', () => ({}))

import { DEFAULT_MUTATION_LIMIT, createInProcessStore, setLimitStore } from '@/lib/limits'
import { apiRoute } from './handler'

const SESSION = {
  userId: 'user_me',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
}

/** A distinct org per test, so each gets its own bucket. */
let orgCounter = 0
function session() {
  return { ...SESSION, organizationId: `org_${++orgCounter}` }
}

function request(method: string): Request {
  return new Request('https://grid.test/api/things', { method })
}

beforeEach(() => {
  setLimitStore(createInProcessStore())
  requireAuthorizedSession.mockReset()
})

afterEach(() => {
  setLimitStore(null)
})

describe('apiRoute rate limiting', () => {
  it('bounds a mutating route that declared no limit at all', async () => {
    const current = session()
    requireAuthorizedSession.mockResolvedValue(current)
    const handler = vi.fn().mockResolvedValue({ ok: true })
    const route = apiRoute(handler, { authz: { sessionOnly: true, why: 'spec' } })

    // A tight loop hits the default's BURST clause long before its sustained
    // budget — which is the point of having one. Everything past it is refused.
    const burst = DEFAULT_MUTATION_LIMIT.burst?.limit ?? DEFAULT_MUTATION_LIMIT.limit
    for (let i = 0; i < burst; i++) {
      expect((await route(request('POST'))).status).toBe(200)
    }
    const refused = await route(request('POST'))

    expect(refused.status).toBe(429)
    // The refusal happens BEFORE the handler: a rate-limited call must not have
    // already touched the database.
    expect(handler).toHaveBeenCalledTimes(burst)
  })

  it('answers a refusal with Retry-After and the policy that bit', async () => {
    const current = session()
    requireAuthorizedSession.mockResolvedValue(current)
    const route = apiRoute(async () => ({ ok: true }), {
      authz: { sessionOnly: true, why: 'spec' },
      limits: { rule: { name: 'spec-tight', limit: 1, windowMs: 60_000 } },
    })

    await route(request('POST'))
    const refused = await route(request('POST'))

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
    expect(refused.headers.get('X-RateLimit-Policy')).toBe('spec-tight')
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('leaves reads to the edge budget rather than charging them here', async () => {
    const current = session()
    requireAuthorizedSession.mockResolvedValue(current)
    const route = apiRoute(async () => ({ ok: true }), {
      authz: { sessionOnly: true, why: 'spec' },
    })

    // Comfortably past the mutation default's burst clause — a chatty UI must
    // not be clipped.
    for (let i = 0; i < (DEFAULT_MUTATION_LIMIT.burst?.limit ?? 0) + 5; i++) {
      expect((await route(request('GET'))).status).toBe(200)
    }
  })

  it('honours an explicit exemption', async () => {
    const current = session()
    requireAuthorizedSession.mockResolvedValue(current)
    const route = apiRoute(async () => ({ ok: true }), {
      authz: { sessionOnly: true, why: 'spec' },
      limits: { none: true, why: 'spec: proves the opt-out is real' },
    })

    for (let i = 0; i < (DEFAULT_MUTATION_LIMIT.burst?.limit ?? 0) + 5; i++) {
      expect((await route(request('POST'))).status).toBe(200)
    }
  })

  it('charges the member within their organization, not the member alone', async () => {
    const rule = { name: 'spec-subject', limit: 1, windowMs: 60_000 }
    const route = apiRoute(async () => ({ ok: true }), {
      authz: { sessionOnly: true, why: 'spec' },
      limits: { rule },
    })

    const inOrgA = { ...SESSION, organizationId: 'org_a' }
    requireAuthorizedSession.mockResolvedValue(inOrgA)
    expect((await route(request('POST'))).status).toBe(200)
    expect((await route(request('POST'))).status).toBe(429)

    // Same person, different tenant: a fresh budget, so work in one org cannot
    // throttle their work in the other.
    requireAuthorizedSession.mockResolvedValue({ ...SESSION, organizationId: 'org_b' })
    expect((await route(request('POST'))).status).toBe(200)
  })
})
