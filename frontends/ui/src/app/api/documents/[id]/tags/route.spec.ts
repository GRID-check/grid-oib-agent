import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
  }),
}))

vi.mock('@/lib/documents/service', () => ({
  updateDocumentTags: vi.fn(),
}))

import { updateDocumentTags } from '@/lib/documents/service'
import { NotFoundError } from '@/lib/api/errors'
import { PATCH } from './route'

const call = (id: string, body: unknown) =>
  PATCH(
    new Request(`https://grid.test/api/documents/${id}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) }
  )

describe('PATCH /api/documents/[id]/tags', () => {
  beforeEach(() => vi.clearAllMocks())

  it('delegates valid tags to the service and returns the result', async () => {
    vi.mocked(updateDocumentTags).mockResolvedValue({
      id: 'doc-1',
      tags: ['Grundriss', 'Brandschutz'],
    })

    const response = await call('doc-1', { tags: ['Grundriss', 'Brandschutz'] })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'doc-1', tags: ['Grundriss', 'Brandschutz'] })
    expect(updateDocumentTags).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'doc-1',
      ['Grundriss', 'Brandschutz']
    )
  })

  it('allows an empty list (clears tags)', async () => {
    vi.mocked(updateDocumentTags).mockResolvedValue({ id: 'doc-1', tags: [] })

    const response = await call('doc-1', { tags: [] })

    expect(response.status).toBe(200)
    expect(updateDocumentTags).toHaveBeenCalledWith(expect.anything(), 'doc-1', [])
  })

  it('rejects a body with too many tags (zod) without calling the service', async () => {
    const response = await call('doc-1', { tags: ['a', 'b', 'c', 'd', 'e', 'f'] })

    expect(response.status).toBe(400)
    expect(updateDocumentTags).not.toHaveBeenCalled()
  })

  it('rejects a malformed body (tags not an array)', async () => {
    const response = await call('doc-1', { tags: 'Grundriss' })

    expect(response.status).toBe(400)
    expect(updateDocumentTags).not.toHaveBeenCalled()
  })

  it('maps a service NotFoundError to 404', async () => {
    vi.mocked(updateDocumentTags).mockRejectedValue(new NotFoundError())

    const response = await call('doc-1', { tags: ['Grundriss'] })

    expect(response.status).toBe(404)
  })
})
