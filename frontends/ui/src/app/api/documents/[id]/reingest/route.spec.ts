/**
 * @vitest-environment node
 */
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
  reingestDocument: vi.fn(),
}))

import { reingestDocument } from '@/lib/documents/service'
import { ConflictError } from '@/lib/api/errors'
import { POST } from './route'

const call = (id: string) =>
  POST(
    new Request(`https://grid.test/api/documents/${id}/reingest`, {
      method: 'POST',
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) }
  )

describe('POST /api/documents/[id]/reingest', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the new status on a successful re-ingest', async () => {
    vi.mocked(reingestDocument).mockResolvedValue({
      id: 'doc-1',
      status: 'pending',
      jobId: 'job-1',
    })

    const response = await call('doc-1')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'doc-1', status: 'pending', jobId: 'job-1' })
    expect(reingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'doc-1'
    )
  })

  it('maps a wrong-status ConflictError to a 409', async () => {
    vi.mocked(reingestDocument).mockRejectedValue(
      new ConflictError('Only failed documents can be re-ingested')
    )

    const response = await call('doc-1')

    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('CONFLICT')
  })
})
