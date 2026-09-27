/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/conversations/service', () => ({
  retryConversationErasure: vi.fn(),
}))

import { ConflictError, UpstreamError } from '@/lib/api/errors'
import { retryConversationErasure } from '@/lib/conversations/service'
import { getTenantContext } from '@/lib/db/tenant-context'
import { POST } from './route'

const REAL_TOKEN = 'a-real-secret-token'
const CONVERSATION_ID = 's_conv-1'

const makeRequest = (body: unknown, token?: string) =>
  new Request(`https://grid.test/api/internal/conversations/${CONVERSATION_ID}/erase`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })

const routeContext = { params: Promise.resolve({ id: CONVERSATION_ID }) }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/conversations/[id]/erase', () => {
  it('refuses a caller without the service token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest({ organizationId: 'org-1' }, 'wrong'), routeContext)

    expect(response.status).toBe(403)
    expect(retryConversationErasure).not.toHaveBeenCalled()
  })

  it('runs the erasure inside the queue row’s organization', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    let scope: unknown
    vi.mocked(retryConversationErasure).mockImplementation(async () => {
      scope = getTenantContext()
      return { outcome: 'erased' }
    })

    const response = await POST(makeRequest({ organizationId: 'org-1' }, REAL_TOKEN), routeContext)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ outcome: 'erased' })
    expect(retryConversationErasure).toHaveBeenCalledWith('org-1', CONVERSATION_ID)
    expect(scope).toMatchObject({ kind: 'tenant', organizationId: 'org-1' })
  })

  it('answers 400 without an organization', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest({}, REAL_TOKEN), routeContext)

    expect(response.status).toBe(400)
    expect(retryConversationErasure).not.toHaveBeenCalled()
  })

  it('answers a hold as 409 legal_hold, which the purger defers on', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(retryConversationErasure).mockRejectedValue(
      new ConflictError('held', { reason: 'legal_hold', entityType: 'conversation' })
    )

    const response = await POST(makeRequest({ organizationId: 'org-1' }, REAL_TOKEN), routeContext)

    expect(response.status).toBe(409)
    expect((await response.json()).details).toMatchObject({ reason: 'legal_hold' })
  })

  it('answers a store that still fails as 502, which the purger counts as an attempt', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(retryConversationErasure).mockRejectedValue(new UpstreamError('still down'))

    const response = await POST(makeRequest({ organizationId: 'org-1' }, REAL_TOKEN), routeContext)

    expect(response.status).toBe(502)
  })
})
