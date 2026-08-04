/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
  }),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { asDb } from '@/test-utils/db-fixtures'
import { GET } from './route'

describe('GET /api/projects/[id]/overview', () => {
  it('returns project overview with stats', async () => {
    const { getDb } = await import('@/lib/db')

    const projectRow = {
      id: 'proj-1',
      name: 'Test Project',
      collectionName: 'proj-1-collection',
      createdAt: new Date('2026-01-01'),
      profile: null,
      profileDisplay: { title: 'Test', summary: 'A test project', keyFacts: [] },
    }
    const statsRow = { count: 1, totalSize: 1024 }
    const recentDocRow = {
      id: 'doc-1',
      filename: 'spec.pdf',
      fileSize: 1024,
      contentType: 'application/pdf',
      status: 'ready',
      createdAt: new Date('2026-01-02'),
    }

    // The overview query issues three selects, in order:
    // 1. project:      select().from().where().limit(1)          -> [projectRow]
    // 2. stats:        select().from().where()  (awaited direct) -> [statsRow]
    // 3. recent docs:  select().from().where().orderBy().limit() -> [recentDocRow]
    const mockLimit = vi
      .fn()
      .mockResolvedValueOnce([projectRow])
      .mockResolvedValueOnce([recentDocRow])
    const mockOrderBy = vi.fn().mockImplementation(() => ({ limit: mockLimit }))
    // where() must be awaitable (stats query) while still exposing the
    // orderBy/limit chain for the project and recent-docs queries.
    const mockWhere = vi.fn().mockImplementation(() =>
      Object.assign(Promise.resolve([statsRow]), {
        orderBy: mockOrderBy,
        limit: mockLimit,
      })
    )
    const mockFrom = vi.fn().mockImplementation(() => ({ where: mockWhere }))
    const mockSelect = vi.fn().mockImplementation(() => ({ from: mockFrom }))

    vi.mocked(getDb).mockReturnValue(asDb({ select: mockSelect }))

    const response = await GET(new Request('https://grid.test/api/projects/proj-1/overview'), {
      params: Promise.resolve({ id: 'proj-1' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveProperty('name', 'Test Project')
    expect(body).toHaveProperty('documentCount')
    expect(body).toHaveProperty('recentDocuments')
  })
})
