// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

import { GET, POST, DELETE } from '@/app/api/jobs/async/[...path]/route'
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

function makeParams(path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) }
}

function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>
  return headers[name]
}

describe('/api/jobs/async/[...path]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.REQUIRE_AUTH
  })

  describe('GET', () => {
    it('forwards scope header for stream requests', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1', 's_conv-1'],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: 'conv-1',
      })
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(createStream(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
      global.fetch = fetchMock

      const req = new Request(
        'http://localhost:3000/api/jobs/async/job/job-1/stream?projectId=proj-1&conversationId=conv-1'
      )
      const res = await GET(req, makeParams(['job', 'job-1', 'stream']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(getHeader(init, 'Accept')).toBe('text/event-stream')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
        projectId: 'proj-1',
        conversationId: 'conv-1',
      })
    })

    it('uses anonymous session when auth is disabled', async () => {
      process.env.REQUIRE_AUTH = 'false'
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 's_conv-1'],
        headerValue: 'anon-scope',
        projectId: undefined,
        conversationId: 'conv-1',
      })
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      global.fetch = fetchMock

      const req = new Request(
        'http://localhost:3000/api/jobs/async/agents?conversationId=conv-1'
      )
      const res = await GET(req, makeParams(['agents']))

      expect(res.status).toBe(200)
      expect(mockRequireAuthorizedSession).not.toHaveBeenCalled()
      expect(getHeader(fetchMock.mock.calls[0][1], 'X-Grid-Collection-Scope')).toBe('anon-scope')
    })

    it('returns 404 when project access is missing', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockRejectedValue(new Error('Not found'))
      const fetchMock = vi.fn()
      global.fetch = fetchMock

      const req = new Request(
        'http://localhost:3000/api/jobs/async/agents?projectId=proj-1'
      )
      const res = await GET(req, makeParams(['agents']))

      expect(res.status).toBe(404)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('POST', () => {
    it('forwards scope header from body', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1', 's_conv-1'],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: 'conv-1',
      })
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ job_id: 'job-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      global.fetch = fetchMock

      const req = new Request('http://localhost:3000/api/jobs/async/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1', conversationId: 'conv-1' }),
      })
      const res = await POST(req, makeParams(['submit']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
        projectId: 'proj-1',
        conversationId: 'conv-1',
      })
    })

    it('returns 404 when project access is missing', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockRejectedValue(new Error('Not found'))
      const fetchMock = vi.fn()
      global.fetch = fetchMock

      const req = new Request('http://localhost:3000/api/jobs/async/submit', {
        method: 'POST',
        body: JSON.stringify({ projectId: 'proj-1' }),
      })
      const res = await POST(req, makeParams(['submit']))

      expect(res.status).toBe(404)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('DELETE', () => {
    it('forwards scope header from query params', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1'],
        headerValue: 'delete-scope',
        projectId: 'proj-1',
        conversationId: undefined,
      })
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'cancelled' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      global.fetch = fetchMock

      const req = new Request(
        'http://localhost:3000/api/jobs/async/job/job-1/cancel?projectId=proj-1'
      )
      const res = await DELETE(req, makeParams(['job', 'job-1', 'cancel']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(init.method).toBe('DELETE')
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('delete-scope')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
        projectId: 'proj-1',
        conversationId: undefined,
      })
    })

    it('returns 404 when project access is missing', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockRejectedValue(new Error('Not found'))
      const fetchMock = vi.fn()
      global.fetch = fetchMock

      const req = new Request(
        'http://localhost:3000/api/jobs/async/job/job-1/cancel?projectId=proj-1'
      )
      const res = await DELETE(req, makeParams(['job', 'job-1', 'cancel']))

      expect(res.status).toBe(404)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
