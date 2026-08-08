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
  persistInternalConversationMessages: vi.fn(),
}))

import { NotFoundError } from '@/lib/api/errors'
import { persistInternalConversationMessages } from '@/lib/conversations/service'
import { POST } from './route'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const REAL_TOKEN = 'a-real-secret-token'
const CONVERSATION_ID = 'conv-1'

const makeRequest = (body: unknown, token?: string) =>
  new Request(`https://grid.test/api/internal/conversations/${CONVERSATION_ID}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })

const routeContext = { params: Promise.resolve({ id: CONVERSATION_ID }) }

const validPayload = {
  organizationId: 'org-1',
  id: '11111111-1111-4111-8111-111111111111',
  role: 'assistant',
  content: 'Here is your finished answer.',
  messageType: 'agent_response',
  metadata: { sources: [] },
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/conversations/[id]/messages', () => {
  it('returns 503 when the internal token is not configured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')

    const response = await POST(makeRequest(validPayload, REAL_TOKEN), routeContext)

    expect(response.status).toBe(503)
    expect(persistInternalConversationMessages).not.toHaveBeenCalled()
  })

  it('returns 403 for a wrong token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest(validPayload, 'wrong-token'), routeContext)

    expect(response.status).toBe(403)
    expect(persistInternalConversationMessages).not.toHaveBeenCalled()
  })

  it('returns 403 when the token header is missing', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest(validPayload), routeContext)

    expect(response.status).toBe(403)
  })

  it('refuses the well-known dev default token outside dev environments (503)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', DEV_DEFAULT_TOKEN)
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('NODE_ENV', 'production')

    const response = await POST(makeRequest(validPayload, DEV_DEFAULT_TOKEN), routeContext)

    expect(response.status).toBe(503)
    expect(persistInternalConversationMessages).not.toHaveBeenCalled()
  })

  it('persists the assistant message with a valid token, org-scoped (201)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(persistInternalConversationMessages).mockResolvedValue([
      { id: validPayload.id } as never,
    ])

    const response = await POST(makeRequest(validPayload, REAL_TOKEN), routeContext)

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.messages).toHaveLength(1)
    // Org scoping + conversation id from the path are threaded to the service,
    // and the message loses its top-level organizationId before insert.
    expect(persistInternalConversationMessages).toHaveBeenCalledWith('org-1', CONVERSATION_ID, [
      expect.objectContaining({
        id: validPayload.id,
        role: 'assistant',
        content: 'Here is your finished answer.',
        messageType: 'agent_response',
      }),
    ])
    expect(vi.mocked(persistInternalConversationMessages).mock.calls[0][2][0]).not.toHaveProperty(
      'organizationId'
    )
  })

  it('is idempotent: onConflictDoNothing means a replayed id no-ops (empty result, still 201)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    // A second write with the same deterministic id conflicts and returns [].
    vi.mocked(persistInternalConversationMessages).mockResolvedValue([])

    const response = await POST(makeRequest(validPayload, REAL_TOKEN), routeContext)

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.messages).toEqual([])
  })

  it('maps a cross-org / unknown conversation to 404 (no token bypass of tenancy)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(persistInternalConversationMessages).mockRejectedValue(new NotFoundError())

    const response = await POST(makeRequest(validPayload, REAL_TOKEN), routeContext)

    expect(response.status).toBe(404)
  })

  it('rejects a body missing the organizationId (400)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const { organizationId: _omit, ...withoutOrg } = validPayload

    const response = await POST(makeRequest(withoutOrg, REAL_TOKEN), routeContext)

    expect(response.status).toBe(400)
    expect(persistInternalConversationMessages).not.toHaveBeenCalled()
  })
})
