import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { GET } from '@/app/api/conversations/[id]/messages/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'

const mockRequireAuthorizedSession = vi.mocked(requireAuthorizedSession)
const mockGetDb = vi.mocked(getDb)

const session = {
  userId: 'user_1',
  email: 'a@b.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member' as const,
  permissions: [] as string[],
  featureFlags: null,
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

describe('/api/conversations/[id]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuthorizedSession.mockResolvedValue(session)
  })

  it('lists messages for a conversation', async () => {
    const messages = [
      { id: '550e8400-e29b-41d4-a716-446655440000', conversationId: 's_conv_1', role: 'user', content: 'hello', metadata: null, createdAt: new Date() },
      { id: '550e8400-e29b-41d4-a716-446655440001', conversationId: 's_conv_1', role: 'assistant', content: 'hi there', metadata: null, createdAt: new Date() },
    ]
    // The bounded message query chains .orderBy().limit(); limit resolves rows.
    const orderByFn = vi.fn(() => ({ limit: vi.fn().mockResolvedValue(messages) }))

    // First call: verify conversation exists
    const convLimitFn = vi.fn().mockResolvedValue([{ id: 's_conv_1', organizationId: 'org_1' }])
    const convWhereFn = vi.fn(() => ({ limit: convLimitFn }))

    // Second call: list messages
    const msgWhereFn = vi.fn(() => ({ orderBy: orderByFn }))

    let callCount = 0
    mockGetDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => {
          callCount++
          if (callCount === 1) return { where: convWhereFn }
          return { where: msgWhereFn }
        }),
      })),
    } as never)

    const req = new Request('http://localhost:3000/api/conversations/s_conv_1/messages')
    const res = await GET(req, makeParams('s_conv_1'))

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toHaveLength(2)
    expect(json[0].role).toBe('user')
  })

  it('returns 404 when conversation does not exist', async () => {
    const convLimitFn = vi.fn().mockResolvedValue([])
    const convWhereFn = vi.fn(() => ({ limit: convLimitFn }))

    mockGetDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: convWhereFn })),
      })),
    } as never)

    const req = new Request('http://localhost:3000/api/conversations/nonexistent/messages')
    const res = await GET(req, makeParams('nonexistent'))

    expect(res.status).toBe(404)
  })
})
