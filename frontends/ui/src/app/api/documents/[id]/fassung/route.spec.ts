/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
  }),
}))

vi.mock('@/lib/documents/fassung-service', () => ({
  setFassungLink: vi.fn(),
}))

import { setFassungLink } from '@/lib/documents/fassung-service'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { PUT } from './route'

const OLDER = '2f1c6e0e-4f0a-4c53-9a3e-0f2b7d8f6a11'

const call = (id: string, body: unknown) =>
  PUT(
    new Request(`https://grid.test/api/documents/${id}/fassung`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) }
  )

describe('PUT /api/documents/[id]/fassung', () => {
  beforeEach(() => vi.clearAllMocks())

  it('links the older document to the one in the path and returns both documents’ facts', async () => {
    const answer = { id: 'doc-b', fassung: null, older: { id: OLDER, fassung: null } }
    vi.mocked(setFassungLink).mockResolvedValue(answer)

    const response = await call('doc-b', { older: OLDER, linked: true })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(answer)
    expect(setFassungLink).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'doc-b',
      OLDER,
      true,
      expect.any(Request)
    )
  })

  it('unlinks with linked: false', async () => {
    vi.mocked(setFassungLink).mockResolvedValue({ id: 'doc-b', fassung: null, older: { id: OLDER, fassung: null } })

    expect((await call('doc-b', { older: OLDER, linked: false })).status).toBe(200)
    expect(setFassungLink).toHaveBeenCalledWith(expect.anything(), 'doc-b', OLDER, false, expect.any(Request))
  })

  it.each([
    ['no body fields', {}],
    ['an older id that is no uuid', { older: 'Grundriss_A.pdf', linked: true }],
    ['linked as text', { older: OLDER, linked: 'yes' }],
    ['no linked', { older: OLDER }],
  ])('rejects %s (zod) without calling the service', async (_name, body) => {
    expect((await call('doc-b', body)).status).toBe(400)
    expect(setFassungLink).not.toHaveBeenCalled()
  })

  it('maps the service’s refusals: 403 without write access, 404 for a document not seen, 400 across collections', async () => {
    vi.mocked(setFassungLink).mockRejectedValueOnce(new ForbiddenError())
    expect((await call('doc-b', { older: OLDER, linked: true })).status).toBe(403)

    vi.mocked(setFassungLink).mockRejectedValueOnce(new NotFoundError())
    expect((await call('doc-b', { older: OLDER, linked: true })).status).toBe(404)

    vi.mocked(setFassungLink).mockRejectedValueOnce(new BadRequestError('x', { reason: 'different_collection' }))
    expect((await call('doc-b', { older: OLDER, linked: true })).status).toBe(400)
  })
})
