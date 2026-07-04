import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { GET, PATCH, DELETE } from '@/app/api/conversations/[id]/route'
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
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

describe('/api/conversations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuthorizedSession.mockResolvedValue(session)
  })

  describe('GET', () => {
    it('returns the conversation when found', async () => {
      const conv = { id: 's_conv_1', organizationId: 'org_1', createdBy: 'user_1', title: 'Chat', projectId: null, createdAt: new Date(), updatedAt: new Date() }
      const limitFn = vi.fn().mockResolvedValue([conv])
      const whereFn = vi.fn(() => ({ limit: limitFn }))

      mockGetDb.mockReturnValue({
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: whereFn })),
        })),
      } as never)

      const req = new Request('http://localhost:3000/api/conversations/s_conv_1')
      const res = await GET(req, makeParams('s_conv_1'))

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.id).toBe('s_conv_1')
    })

    it('returns 404 when not found', async () => {
      const limitFn = vi.fn().mockResolvedValue([])
      const whereFn = vi.fn(() => ({ limit: limitFn }))

      mockGetDb.mockReturnValue({
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: whereFn })),
        })),
      } as never)

      const req = new Request('http://localhost:3000/api/conversations/nonexistent')
      const res = await GET(req, makeParams('nonexistent'))

      expect(res.status).toBe(404)
    })
  })

  describe('PATCH', () => {
    it('updates the conversation title', async () => {
      const updated = { id: 's_conv_1', organizationId: 'org_1', createdBy: 'user_1', title: 'Updated', projectId: null, createdAt: new Date(), updatedAt: new Date() }
      const returningFn = vi.fn().mockResolvedValue([updated])
      const whereFn = vi.fn(() => ({ returning: returningFn }))

      mockGetDb.mockReturnValue({
        update: vi.fn(() => ({
          set: vi.fn(() => ({ where: whereFn })),
        })),
      } as never)

      const req = new Request('http://localhost:3000/api/conversations/s_conv_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      })
      const res = await PATCH(req, makeParams('s_conv_1'))

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.title).toBe('Updated')
    })

    it('returns 400 for missing title', async () => {
      const req = new Request('http://localhost:3000/api/conversations/s_conv_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const res = await PATCH(req, makeParams('s_conv_1'))

      expect(res.status).toBe(400)
    })
  })

  describe('DELETE', () => {
    it('deletes the conversation', async () => {
      const whereFn = vi.fn().mockResolvedValue(undefined)

      mockGetDb.mockReturnValue({
        delete: vi.fn(() => ({
          where: whereFn,
        })),
      } as never)

      const req = new Request('http://localhost:3000/api/conversations/s_conv_1', { method: 'DELETE' })
      const res = await DELETE(req, makeParams('s_conv_1'))

      expect(res.status).toBe(204)
    })
  })
})
