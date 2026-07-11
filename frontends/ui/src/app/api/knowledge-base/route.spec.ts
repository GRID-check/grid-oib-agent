import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UpstreamError } from '@/lib/api/errors'

const requireAuthorizedSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: requireAuthorizedSessionMock,
}))

const getKnowledgeBaseStatusMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/knowledge/service', () => ({
  getKnowledgeBaseStatus: getKnowledgeBaseStatusMock,
}))

import { GET } from './route'

describe('GET /api/knowledge-base', () => {
  beforeEach(() => {
    requireAuthorizedSessionMock.mockReset()
    requireAuthorizedSessionMock.mockResolvedValue({
      userId: 'user_1',
      organizationId: 'org_1',
      role: 'member',
      permissions: [],
    })
    getKnowledgeBaseStatusMock.mockReset()
  })

  it('returns the knowledge-base status for an authenticated session', async () => {
    const status = {
      collectionName: 'oib_knowledge',
      collectionExists: true,
      collectionUpdatedAt: null,
      summary: {
        totalFiles: 1,
        ingested: 1,
        stale: 0,
        pending: 0,
        removed: 0,
        inconsistent: 0,
        totalChunks: 7,
      },
      files: [],
    }
    getKnowledgeBaseStatusMock.mockResolvedValue(status)

    const res = await GET(new Request('https://grid.example/api/knowledge-base'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(status)
  })

  it('maps upstream failures to the typed error envelope', async () => {
    getKnowledgeBaseStatusMock.mockRejectedValue(new UpstreamError('Knowledge backend unreachable'))

    const res = await GET(new Request('https://grid.example/api/knowledge-base'))

    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'UPSTREAM_ERROR' })
  })
})
