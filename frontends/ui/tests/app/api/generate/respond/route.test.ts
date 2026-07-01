// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

import { POST } from '@/app/api/generate/respond/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

const mockRequireAuthorizedSession = vi.mocked(requireAuthorizedSession)
const mockBuildCollectionScopeFromRequest = vi.mocked(buildCollectionScopeFromRequest)

const baseSession = {
  userId: 'user_1',
  email: 'a@b.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [] as string[],
}

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
  global.fetch = fetchMock
  return fetchMock
}

function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>
  return headers[name]
}

describe('/api/generate/respond', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.REQUIRE_AUTH
  })

  it('forwards scope header with project and session_id as conversation', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireAuthorizedSession.mockResolvedValue(baseSession)
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_proj-1', 's_conv-1'],
      headerValue: 'encoded-scope',
      projectId: 'proj-1',
      conversationId: 'conv-1',
    })
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/generate/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-1', session_id: 'conv-1', response: 'yes' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
    expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
      projectId: 'proj-1',
      conversationId: 'conv-1',
    })
  })

  it('forwards base-only scope header when auth is disabled', async () => {
    process.env.REQUIRE_AUTH = 'false'
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge'],
      headerValue: 'base-only',
      projectId: undefined,
      conversationId: undefined,
    })
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/generate/respond', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockRequireAuthorizedSession).not.toHaveBeenCalled()
    expect(getHeader(fetchMock.mock.calls[0][1], 'X-Grid-Collection-Scope')).toBe('base-only')
  })

  it('returns 404 when project access is missing', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireAuthorizedSession.mockResolvedValue(baseSession)
    mockBuildCollectionScopeFromRequest.mockRejectedValue(new Error('Not found'))
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/generate/respond', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'proj-1' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
