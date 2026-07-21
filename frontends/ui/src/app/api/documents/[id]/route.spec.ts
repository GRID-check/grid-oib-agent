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
  deleteDocument: vi.fn(),
}))

import { deleteDocument } from '@/lib/documents/service'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { DELETE } from './route'

const call = (id: string) =>
  DELETE(
    new Request(`https://grid.test/api/documents/${id}`, { method: 'DELETE' }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) },
  )

describe('DELETE /api/documents/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes the document and returns 204 No Content', async () => {
    vi.mocked(deleteDocument).mockResolvedValue(undefined)

    const response = await call('doc-1')

    expect(response.status).toBe(204)
    expect(deleteDocument).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'doc-1',
      expect.any(Request),
    )
  })

  it('maps a NotFoundError to a 404', async () => {
    vi.mocked(deleteDocument).mockRejectedValue(new NotFoundError())

    const response = await call('missing')

    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe('NOT_FOUND')
  })

  it('maps a ForbiddenError to a 403', async () => {
    vi.mocked(deleteDocument).mockRejectedValue(new ForbiddenError())

    const response = await call('doc-1')

    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('FORBIDDEN')
  })
})
