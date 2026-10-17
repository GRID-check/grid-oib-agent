/**
 * @vitest-environment node
 */
/**
 * The Worker's webhook route: its own token, and that the route hands the
 * request to the service untouched. What the service answers, and which
 * answers carry the reject verdict, is `lib/inbound-mail/receive.spec.ts`.
 *
 * Pinned here because it is the route factory, not the service, that answers a
 * wrong token: that answer must NOT carry `x-inbound-verdict`, or a rotated
 * credential on one side would bounce every member's mail (review K3/C3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
// The route factory statically imports the session guard; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({
  runWithTenantSlot: vi.fn((fn: () => unknown) => fn()),
  withPlatformAccess: vi.fn((_reason: string, fn: () => unknown) => fn()),
  withTenant: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}))
vi.mock('@/lib/inbound-mail/receive', () => ({ receiveInboundMail: vi.fn() }))

import { withPlatformAccess } from '@/lib/db/tenant-context'
import { receiveInboundMail } from '@/lib/inbound-mail/receive'
import { POST } from './route'

const TOKEN = 'a-real-inbound-token'

function deliver(token: string | null = TOKEN) {
  const headers: Record<string, string> = { 'x-envelope-to': 'wohnbau.abcdefgh2345@piloti-post.at' }
  if (token !== null) headers['x-grid-internal-token'] = token
  return POST(new Request('https://grid.test/api/internal/inbound-mail', { method: 'POST', headers, body: 'raw' }))
}

beforeEach(() => {
  vi.stubEnv('GRID_INBOUND_MAIL_TOKEN', TOKEN)
  vi.mocked(receiveInboundMail).mockResolvedValue(Response.json({ status: 'queued' }, { status: 202 }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/inbound-mail', () => {
  it('refuses a missing or wrong token before touching anything, and never with the reject verdict', async () => {
    for (const response of [await deliver(null), await deliver('wrong')]) {
      expect(response.status).toBe(403)
      expect(response.headers.get('x-inbound-verdict')).toBeNull()
    }
    expect(receiveInboundMail).not.toHaveBeenCalled()
  })

  it('does not accept the shared service token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'the-service-token')
    expect((await deliver('the-service-token')).status).toBe(403)
  })

  it('is disabled (503, retried) while its token is unconfigured', async () => {
    vi.stubEnv('GRID_INBOUND_MAIL_TOKEN', '')
    const response = await deliver()
    expect(response.status).toBe(503)
    expect(response.headers.get('x-inbound-verdict')).toBeNull()
  })

  it('hands the request to the service and answers what it answers', async () => {
    const response = await deliver()
    expect(response.status).toBe(202)
    expect(receiveInboundMail).toHaveBeenCalledWith(expect.any(Request))
    // The route opens no scope of its own: the service takes the one
    // cross-tenant step (the token lookup) and nothing else under it.
    expect(withPlatformAccess).not.toHaveBeenCalled()
  })
})
