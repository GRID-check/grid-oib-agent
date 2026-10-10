/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
    // The overview asks who of the project's quarantine this reader may see.
    permissions: [],
  }),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())

import { asDb } from '@/test-utils/db-fixtures'
import { NotFoundError } from '@/lib/api/errors'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
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
    // The counts and the recent list leave out what this session may not see (ADR-0087).
    const { getHiddenFolderIds } = await import('@/lib/authz/folder-access')
    expect(getHiddenFolderIds).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'proj-1')
  })

  // ADR-0086: the recent list names a file, the count and size move with it.
  // A member who neither uploaded a quarantined file nor reviews the project's
  // quarantine must not find it here, so the route has to hand the query a reader.
  it("narrows the count, size and recent list to a member's own quarantined files", async () => {
    const { getDb } = await import('@/lib/db')
    const member = {
      userId: 'member-1',
      organizationId: 'org-1',
      email: 'member@grid.com',
      role: 'member',
      permissions: [],
    } as unknown as AuthorizedSession
    vi.mocked(requireAuthorizedSession).mockResolvedValueOnce(member)
    // A project member, not its admin: `project:manage` is refused.
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, _projectId, permission) => {
      if (permission === 'project:manage') throw new NotFoundError('Project not found')
      return { role: 'project-viewer' } as Awaited<ReturnType<typeof requireProjectAccess>>
    })

    const predicates: SQL[] = []
    const projectRow = { id: 'proj-1', name: 'P', collectionName: 'c', createdAt: new Date(), profile: null, profileDisplay: null }
    const mockLimit = vi.fn().mockResolvedValueOnce([projectRow]).mockResolvedValueOnce([])
    const mockWhere = vi.fn().mockImplementation((predicate: SQL) => {
      predicates.push(predicate)
      return Object.assign(Promise.resolve([{ count: 0, totalSize: 0 }]), {
        orderBy: () => ({ limit: mockLimit }),
        limit: mockLimit,
      })
    })
    vi.mocked(getDb).mockReturnValue(
      asDb({ select: vi.fn().mockImplementation(() => ({ from: () => ({ where: mockWhere }) })) })
    )

    const response = await GET(new Request('https://grid.test/api/projects/proj-1/overview'), {
      params: Promise.resolve({ id: 'proj-1' }),
    })
    expect(response.status).toBe(200)

    // The project row, then the stats, then the recent list.
    expect(predicates).toHaveLength(3)
    for (const predicate of predicates.slice(1)) {
      const { params } = new PgDialect().sqlToQuery(predicate)
      expect(params).toEqual(expect.arrayContaining(['quarantined', 'member-1']))
    }
  })
})
