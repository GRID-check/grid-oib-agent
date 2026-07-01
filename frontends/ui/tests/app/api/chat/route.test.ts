// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

import { POST } from '@/app/api/chat/route'
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

function createStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: hello\n\n'))
      controller.close()
    },
  })
}

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(createStream(), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  )
  global.fetch = fetchMock
  return fetchMock
}

function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>
  return headers[name]
}

describe('/api/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.REQUIRE_AUTH
  })

  it('forwards scope header with project and conversation', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireAuthorizedSession.mockResolvedValue(baseSession)
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_proj-1', 's_conv-1'],
      headerValue: 'encoded-scope',
      projectId: 'proj-1',
      conversationId: 'conv-1',
    })
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-1', conversationId: 'conv-1', message: 'hi' }),
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

  it('forwards scope header without project', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireAuthorizedSession.mockResolvedValue(baseSession)
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge', 's_conv-1'],
      headerValue: 'no-project',
      projectId: undefined,
      conversationId: 'conv-1',
    })
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'conv-1' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(getHeader(fetchMock.mock.calls[0][1], 'X-Grid-Collection-Scope')).toBe('no-project')
    expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
      projectId: undefined,
      conversationId: 'conv-1',
    })
  })

  it('forwards scope header without conversation', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireAuthorizedSession.mockResolvedValue(baseSession)
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_proj-1'],
      headerValue: 'no-conversation',
      projectId: 'proj-1',
      conversationId: undefined,
    })
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'proj-1' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(getHeader(fetchMock.mock.calls[0][1], 'X-Grid-Collection-Scope')).toBe('no-conversation')
  })

  it('forwards base-only scope header when neither project nor conversation', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireAuthorizedSession.mockResolvedValue(baseSession)
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge'],
      headerValue: 'base-only',
      projectId: undefined,
      conversationId: undefined,
    })
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(getHeader(fetchMock.mock.calls[0][1], 'X-Grid-Collection-Scope')).toBe('base-only')
  })

  it('uses anonymous session when auth is disabled', async () => {
    process.env.REQUIRE_AUTH = 'false'
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge', 's_conv-1'],
      headerValue: 'anon-conv',
      projectId: undefined,
      conversationId: 'conv-1',
    })
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'conv-1' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockRequireAuthorizedSession).not.toHaveBeenCalled()
    expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(null, {
      projectId: undefined,
      conversationId: 'conv-1',
    })
    expect(getHeader(fetchMock.mock.calls[0][1], 'X-Grid-Collection-Scope')).toBe('anon-conv')
  })

  it('returns 404 and does not forward header when project access is missing', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireAuthorizedSession.mockResolvedValue(baseSession)
    mockBuildCollectionScopeFromRequest.mockRejectedValue(new Error('Not found'))
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'proj-1' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 403 on unauthorized authorization failure', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireAuthorizedSession.mockResolvedValue(baseSession)
    mockBuildCollectionScopeFromRequest.mockRejectedValue(new Error('Forbidden'))
    const fetchMock = mockFetch()

    const req = new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'proj-1' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
