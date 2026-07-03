// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

import { GET } from './route'

describe('GET /api/projects/[id]/overview', () => {
  it('returns project overview with stats', async () => {
    const { getDb } = await import('@/lib/db')
    const mockSelect = vi.fn().mockReturnThis()
    const mockFrom = vi.fn().mockReturnThis()
    const mockWhere = vi.fn().mockReturnThis()
    const mockOrderBy = vi.fn().mockReturnThis()
    const mockLimit = vi.fn().mockReturnThis()

    mockLimit.mockResolvedValue([
      {
        id: 'proj-1',
        name: 'Test Project',
        collectionName: 'proj-1-collection',
        createdAt: new Date('2026-01-01'),
        profileDisplay: { title: 'Test', summary: 'A test project' },
      },
    ])

    mockSelect.mockImplementation((fields?: unknown) => {
      if (fields && typeof fields === 'object' && 'count' in (fields as any)) {
        return { from: mockFrom }
      }
      return { from: mockFrom }
    })

    mockFrom.mockImplementation((_table: unknown) => ({ where: mockWhere }))
    mockWhere.mockImplementation((_condition: unknown) => ({
      orderBy: mockOrderBy,
      limit: mockLimit,
    }))
    mockOrderBy.mockImplementation((_col: unknown) => ({ limit: mockLimit }))

    vi.mocked(getDb).mockReturnValue({
      select: mockSelect,
      from: mockFrom,
      where: mockWhere,
      orderBy: mockOrderBy,
      limit: mockLimit,
    } as any)

    const response = await GET(
      new Request('https://grid.test/api/projects/proj-1/overview'),
      { params: Promise.resolve({ id: 'proj-1' }) },
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveProperty('name', 'Test Project')
    expect(body).toHaveProperty('documentCount')
    expect(body).toHaveProperty('recentDocuments')
  })
})
