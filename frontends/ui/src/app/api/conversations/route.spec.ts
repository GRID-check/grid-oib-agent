import { beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull, or } from 'drizzle-orm'
import { conversations } from '@/lib/db/schema'
import { NotFoundError } from '@/lib/api/errors'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    role: 'member',
    permissions: [],
  }),
  authzErrorResponse: () => null,
}))

const requireProjectAccessMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: requireProjectAccessMock,
}))

// Drizzle select-chain stub: capture the WHERE clause the repository builds.
const whereSpy = vi.fn()
const limitSpy = vi.fn()
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: whereSpy })),
    })),
  }),
}))

import { GET } from './route'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

describe('GET /api/conversations', () => {
  beforeEach(() => {
    whereSpy.mockReset()
    limitSpy.mockReset()
    limitSpy.mockResolvedValue([])
    whereSpy.mockReturnValue({ orderBy: vi.fn(() => ({ limit: limitSpy })) })
    requireProjectAccessMock.mockReset()
    requireProjectAccessMock.mockResolvedValue({ role: 'owner' })
  })

  it('lists org-wide (tenant-scoped) when no projectId filter is given', async () => {
    const res = await GET(new Request('https://grid.example/api/conversations'))

    expect(res.status).toBe(200)
    expect(requireProjectAccessMock).not.toHaveBeenCalled()
    expect(whereSpy).toHaveBeenCalledTimes(1)
    // Tenancy lives in SQL: the WHERE clause must scope by the caller's org.
    expect(whereSpy.mock.calls[0][0]).toEqual(eq(conversations.organizationId, 'org_1'))
  })

  it('scopes by projectId, keeping org tenancy AND the legacy null fail-open rule', async () => {
    const res = await GET(
      new Request(`https://grid.example/api/conversations?projectId=${PROJECT_ID}`),
    )

    expect(res.status).toBe(200)
    expect(whereSpy).toHaveBeenCalledTimes(1)
    // Fail-open display rule: rows stamped with the project OR legacy rows
    // with a NULL project_id — never rows from other projects, and always
    // inside the caller's org.
    expect(whereSpy.mock.calls[0][0]).toEqual(
      and(
        eq(conversations.organizationId, 'org_1'),
        or(eq(conversations.projectId, PROJECT_ID), isNull(conversations.projectId)),
      ),
    )
  })

  it('requires project access for a projectId filter (cross-org probing -> 404)', async () => {
    requireProjectAccessMock.mockRejectedValue(new NotFoundError())

    const res = await GET(
      new Request(`https://grid.example/api/conversations?projectId=${PROJECT_ID}`),
    )

    expect(requireProjectAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1', userId: 'user_1' }),
      PROJECT_ID,
      'project:view',
    )
    expect(res.status).toBe(404)
    // The repository must never be reached for a project the caller can't see.
    expect(whereSpy).not.toHaveBeenCalled()
  })

  it('rejects a malformed projectId with 400', async () => {
    const res = await GET(
      new Request('https://grid.example/api/conversations?projectId=not-a-uuid'),
    )

    expect(res.status).toBe(400)
    expect(requireProjectAccessMock).not.toHaveBeenCalled()
    expect(whereSpy).not.toHaveBeenCalled()
  })
})
