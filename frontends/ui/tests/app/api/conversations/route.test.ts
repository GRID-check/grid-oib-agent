/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
  // The route calls this in its catch block; the real impl returns null for a
  // non-authz error (so the original error rethrows). Mirror that here.
  authzErrorResponse: vi.fn(() => null),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { GET, POST } from '@/app/api/conversations/route'
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

function mockDbChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    returning: vi.fn(() => Promise.resolve([])),
    values: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    set: vi.fn(() => chain),
    ...overrides,
  }
  return chain
}

describe('/api/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuthorizedSession.mockResolvedValue(session)
  })

  describe('GET', () => {
    it('lists conversations for the authorized org', async () => {
      const rows = [
        { id: 's_conv_1', organizationId: 'org_1', createdBy: 'user_1', title: 'Chat 1', projectId: null, createdAt: new Date(), updatedAt: new Date() },
        { id: 's_conv_2', organizationId: 'org_1', createdBy: 'user_1', title: 'Chat 2', projectId: null, createdAt: new Date(), updatedAt: new Date() },
      ]
      const whereFn = vi.fn().mockReturnThis()
      // The bounded list query chains .orderBy().limit(); limit resolves rows.
      const orderByFn = vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) }))

      mockGetDb.mockReturnValue(mockDbChain({
        from: vi.fn(() => ({ where: whereFn, orderBy: orderByFn })),
      }) as never)

      const req = new Request('http://localhost:3000/api/conversations')
      const res = await GET(req)

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toHaveLength(2)
      expect(json[0].id).toBe('s_conv_1')
    })

    it('returns 401 when not authenticated', async () => {
      mockRequireAuthorizedSession.mockRejectedValue(new Error('NEXT_REDIRECT'))

      const req = new Request('http://localhost:3000/api/conversations')

      await expect(GET(req)).rejects.toThrow('NEXT_REDIRECT')
    })
  })

  describe('POST', () => {
    it('creates a new conversation and returns it', async () => {
      const created = { id: 's_conv_new', organizationId: 'org_1', createdBy: 'user_1', title: 'New Chat', projectId: null, createdAt: new Date(), updatedAt: new Date() }
      const returningFn = vi.fn().mockResolvedValue([created])

      mockGetDb.mockReturnValue(mockDbChain({
        returning: returningFn,
        values: vi.fn(function (this: Record<string, unknown>) { return this }),
      }) as never)

      const req = new Request('http://localhost:3000/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 's_new_conv', title: 'New Chat' }),
      })
      const res = await POST(req)

      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json.id).toBe('s_conv_new')
    })

    it('returns 400 when id is missing', async () => {
      const req = new Request('http://localhost:3000/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'No ID' }),
      })
      const res = await POST(req)

      expect(res.status).toBe(400)
    })

    it('returns 400 when body is not valid JSON', async () => {
      const req = new Request('http://localhost:3000/api/conversations', {
        method: 'POST',
        body: 'not-json',
      })
      const res = await POST(req)

      expect(res.status).toBe(400)
    })
  })
})
