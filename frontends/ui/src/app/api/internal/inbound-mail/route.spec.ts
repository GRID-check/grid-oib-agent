/**
 * @vitest-environment node
 */
/**
 * The Worker's webhook: its own token, the envelope recipient, the size cap,
 * and the one cross-tenant lookup followed by a scope for exactly the
 * organization the token named. The filing itself is the service's spec.
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
vi.mock('@/lib/inbound-mail/repository', () => ({ findActiveAddressByToken: vi.fn() }))
vi.mock('@/lib/inbound-mail/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inbound-mail/service')>()
  return { ...actual, receiveInboundMail: vi.fn() }
})

import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { findActiveAddressByToken } from '@/lib/inbound-mail/repository'
import { MAX_MESSAGE_BYTES, receiveInboundMail } from '@/lib/inbound-mail/service'
import { POST } from './route'

const TOKEN = 'a-real-inbound-token'
const RAW = 'From: anna@buero-a.at\r\nSubject: Pläne\r\n\r\nHallo\r\n'
const ADDRESS = { addressId: 'addr-a', organizationId: 'org_A', projectId: 'proj-a' }

function deliver(options: { token?: string | null; to?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'message/rfc822',
    'x-envelope-to': options.to ?? 'wohnbau.abcdefgh2345@piloti-post.at',
    'x-envelope-from': 'bounce@buero-a.at',
    ...options.headers,
  }
  if (options.token !== null) headers['x-grid-internal-token'] = options.token ?? TOKEN
  return POST(
    new Request('https://grid.test/api/internal/inbound-mail', {
      method: 'POST',
      headers,
      body: options.body ?? RAW,
      // Node's fetch Request needs this for a streamed body.
      ...({ duplex: 'half' } as RequestInit),
    })
  )
}

beforeEach(() => {
  vi.stubEnv('GRID_INBOUND_MAIL_TOKEN', TOKEN)
  vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', 'piloti-post.at')
  vi.mocked(findActiveAddressByToken).mockResolvedValue(ADDRESS)
  vi.mocked(receiveInboundMail).mockResolvedValue({ status: 'filed', filed: 1, skipped: [] })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/inbound-mail', () => {
  it('refuses a missing or wrong token before touching anything', async () => {
    expect((await deliver({ token: null })).status).toBe(403)
    expect((await deliver({ token: 'wrong' })).status).toBe(403)
    expect(findActiveAddressByToken).not.toHaveBeenCalled()
    expect(receiveInboundMail).not.toHaveBeenCalled()
  })

  it('does not accept the shared service token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'the-service-token')
    expect((await deliver({ token: 'the-service-token' })).status).toBe(403)
  })

  it('is disabled (503) while its token is unconfigured', async () => {
    vi.stubEnv('GRID_INBOUND_MAIL_TOKEN', '')
    expect((await deliver()).status).toBe(503)
  })

  it('files a mail for the token’s organization, and only in its scope', async () => {
    const response = await deliver()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'filed', filed: 1, skipped: [] })
    expect(withPlatformAccess).toHaveBeenCalledWith(
      'inbound mail: the address token names the project before any organization is known',
      expect.any(Function)
    )
    expect(findActiveAddressByToken).toHaveBeenCalledWith('abcdefgh2345')
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_A' }, expect.any(Function))
    const [address, raw] = vi.mocked(receiveInboundMail).mock.calls[0]
    expect(address).toEqual(ADDRESS)
    expect(Buffer.from(raw).toString()).toBe(RAW)
  })

  it('answers 404 for an unknown or revoked token', async () => {
    vi.mocked(findActiveAddressByToken).mockResolvedValue(null)
    expect((await deliver()).status).toBe(404)
    expect(receiveInboundMail).not.toHaveBeenCalled()
  })

  it('answers 404 for a domain that is not ours, without a lookup', async () => {
    expect((await deliver({ to: 'wohnbau.abcdefgh2345@example.com' })).status).toBe(404)
    expect((await deliver({ to: 'garbage' })).status).toBe(404)
    expect(findActiveAddressByToken).not.toHaveBeenCalled()
  })

  it('answers 413 above 25 MiB, by the declared length and by the bytes actually sent', async () => {
    const declared = await deliver({ headers: { 'content-length': String(MAX_MESSAGE_BYTES + 1) } })
    expect(declared.status).toBe(413)

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024)
        for (let i = 0; i < 26; i += 1) controller.enqueue(chunk)
        controller.close()
      },
    })
    expect((await deliver({ body: oversized })).status).toBe(413)
    expect(findActiveAddressByToken).not.toHaveBeenCalled()
  })

  it('passes the service’s refusals through with their status', async () => {
    const { ForbiddenError } = await import('@/lib/api/errors')
    vi.mocked(receiveInboundMail).mockRejectedValue(new ForbiddenError('Sender is not permitted'))
    expect((await deliver()).status).toBe(403)
  })
})
