// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

import { GET, POST, DELETE } from '@/app/api/v1/[...path]/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { requireProjectAccess } from '@/lib/authz/projects'

const mockRequireAuthorizedSession = vi.mocked(requireAuthorizedSession)
const mockBuildCollectionScopeFromRequest = vi.mocked(buildCollectionScopeFromRequest)
const mockRequireProjectAccess = vi.mocked(requireProjectAccess)

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

function makeParams(path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) }
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(response = makeJsonResponse({ ok: true })): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response)
  global.fetch = fetchMock
  return fetchMock
}

function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>
  return headers[name]
}

function getUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  return fetchMock.mock.calls[0][0] as string
}

describe('/api/v1/[...path]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.REQUIRE_AUTH
    delete process.env.BASE_COLLECTION_NAME
  })

  describe('scope header', () => {
    it('attaches scope header for GET requests', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1', 's_conv-1'],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: 'conv-1',
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/agents?projectId=proj-1&conversationId=conv-1'
      )
      const res = await GET(req, makeParams(['agents']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(getHeader(init, 'Accept')).toBe('application/json')
      expect(getHeader(init, 'Authorization')).toBe('Bearer tok')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
        projectId: 'proj-1',
        conversationId: 'conv-1',
      })
    })

    it('attaches scope header for POST JSON requests', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1', 's_conv-1'],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: 'conv-1',
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request('http://localhost:3000/api/v1/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1', session_id: 'conv-1', query: 'hi' }),
      })
      const res = await POST(req, makeParams(['query']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(getHeader(init, 'Content-Type')).toBe('application/json')
      expect(getHeader(init, 'Authorization')).toBe('Bearer tok')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
        projectId: 'proj-1',
        conversationId: 'conv-1',
      })
    })

    it('attaches scope header for multipart uploads', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockRequireProjectAccess.mockResolvedValue({ role: 'project-editor' })
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1'],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: undefined,
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('--boundary--'))
          controller.close()
        },
      })
      const req = new Request(
        'http://localhost:3000/api/v1/collections/proj_proj-1/documents',
        {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data; boundary=----boundary' },
          body: stream,
        }
      )
      const res = await POST(req, makeParams(['collections', 'proj_proj-1', 'documents']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(getHeader(init, 'Authorization')).toBe('Bearer tok')
      expect(init.body).toBe(stream)
      expect((init as RequestInit & { duplex?: string }).duplex).toBe('half')
    })

    it('attaches scope header for DELETE requests', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1'],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: undefined,
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/documents/doc-1?projectId=proj-1',
        { method: 'DELETE' }
      )
      const res = await DELETE(req, makeParams(['documents', 'doc-1']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(init.method).toBe('DELETE')
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(getHeader(init, 'Authorization')).toBe('Bearer tok')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
        projectId: 'proj-1',
        conversationId: undefined,
      })
    })

    it('uses anonymous session when auth is disabled', async () => {
      process.env.REQUIRE_AUTH = 'false'
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 's_conv-1'],
        headerValue: 'anon-scope',
        projectId: undefined,
        conversationId: 'conv-1',
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/agents?conversationId=conv-1'
      )
      const res = await GET(req, makeParams(['agents']))

      expect(res.status).toBe(200)
      expect(mockRequireAuthorizedSession).not.toHaveBeenCalled()
      expect(getHeader(fetchMock.mock.calls[0][1], 'X-Grid-Collection-Scope')).toBe('anon-scope')
      expect(getHeader(fetchMock.mock.calls[0][1], 'Authorization')).toBeUndefined()
    })
  })

  describe('collection name validation', () => {
    it('allows upload to proj_<id> with project:edit membership', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockRequireProjectAccess.mockResolvedValue({ role: 'project-editor' })
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1'],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: undefined,
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/collections/proj_proj-1/documents',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'proj-1' }),
        }
      )
      const res = await POST(req, makeParams(['collections', 'proj_proj-1', 'documents']))

      expect(res.status).toBe(200)
      expect(mockRequireProjectAccess).toHaveBeenCalledWith(baseSession, 'proj-1', 'project:edit')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('rejects upload to proj_<id> without project:edit membership', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockRequireProjectAccess.mockRejectedValue(new Error('Not found'))
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/collections/proj_proj-1/documents',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'proj-1' }),
        }
      )
      const res = await POST(req, makeParams(['collections', 'proj_proj-1', 'documents']))

      expect(res.status).toBe(404)
      expect(mockRequireProjectAccess).toHaveBeenCalledWith(baseSession, 'proj-1', 'project:edit')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('allows upload to s_<id> when it matches active conversationId', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 's_conv-1'],
        headerValue: 'encoded-scope',
        projectId: undefined,
        conversationId: 'conv-1',
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/collections/s_conv-1/documents',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: 'conv-1' }),
        }
      )
      const res = await POST(req, makeParams(['collections', 's_conv-1', 'documents']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('rejects upload to s_<id> when no conversationId is active', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge'],
        headerValue: 'encoded-scope',
        projectId: undefined,
        conversationId: undefined,
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/collections/s_conv-1/documents',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
      const res = await POST(req, makeParams(['collections', 's_conv-1', 'documents']))

      expect(res.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects upload to base corpus', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/collections/oib_knowledge/documents',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
      const res = await POST(req, makeParams(['collections', 'oib_knowledge', 'documents']))

      expect(res.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects upload to arbitrary collection name', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/collections/random-name/documents',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
      const res = await POST(req, makeParams(['collections', 'random-name', 'documents']))

      expect(res.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
