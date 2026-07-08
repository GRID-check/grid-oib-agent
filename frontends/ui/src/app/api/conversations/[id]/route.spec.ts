import { beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { conversations } from '@/lib/db/schema'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    role: 'member',
    permissions: [],
  }),
  authzErrorResponse: () => null,
}))

const whereSpy = vi.fn()
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    delete: vi.fn(() => ({ where: whereSpy })),
  }),
}))

import { DELETE } from './route'

describe('DELETE /api/conversations/[id]', () => {
  beforeEach(() => {
    whereSpy.mockClear()
    whereSpy.mockResolvedValue(undefined)
  })

  it('scopes the delete to the caller organization (tenant isolation)', async () => {
    const res = await DELETE(new Request('https://grid.example/api/conversations/conv_1', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'conv_1' }),
    })
    expect(res.status).toBe(204)
    expect(whereSpy).toHaveBeenCalledTimes(1)
    // Regression: deleting by id alone let any signed-in user delete another
    // org's conversation. The WHERE clause must carry BOTH conditions.
    expect(whereSpy.mock.calls[0][0]).toEqual(
      and(eq(conversations.id, 'conv_1'), eq(conversations.organizationId, 'org_1')),
    )
  })
})
