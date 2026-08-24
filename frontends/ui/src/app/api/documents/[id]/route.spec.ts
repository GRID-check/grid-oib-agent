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
  deleteDocument: vi.fn(),
  renameDocument: vi.fn(),
}))

import { deleteDocument, renameDocument } from '@/lib/documents/service'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { DELETE, PATCH } from './route'

const call = (id: string) =>
  DELETE(
    new Request(`https://grid.test/api/documents/${id}`, {
      method: 'DELETE',
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) }
  )

const rename = (id: string, body: unknown) =>
  PATCH(
    new Request(`https://grid.test/api/documents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) }
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
      expect.any(Request)
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

describe('PATCH /api/documents/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renames the document and answers with the stored name', async () => {
    vi.mocked(renameDocument).mockResolvedValue({
      id: 'doc-1',
      filename: 'plan.pdf',
      displayName: 'Einreichplan.pdf',
    })

    const response = await rename('doc-1', { displayName: 'Einreichplan.pdf' })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ displayName: 'Einreichplan.pdf' })
    expect(renameDocument).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'doc-1',
      'Einreichplan.pdf',
      expect.any(Request)
    )
  })

  it('accepts null as the clear — it is a value, not an omission', async () => {
    vi.mocked(renameDocument).mockResolvedValue({
      id: 'doc-1',
      filename: 'plan.pdf',
      displayName: null,
    })

    const response = await rename('doc-1', { displayName: null })

    expect(response.status).toBe(200)
    expect(renameDocument).toHaveBeenCalledWith(
      expect.anything(),
      'doc-1',
      null,
      expect.any(Request)
    )
  })

  it('rejects a body without the field at all (400), never renaming to undefined', async () => {
    const response = await rename('doc-1', {})

    expect(response.status).toBe(400)
    expect(renameDocument).not.toHaveBeenCalled()
  })

  it('maps the service\'s refusal of an unusable name to a 400', async () => {
    vi.mocked(renameDocument).mockRejectedValue(new BadRequestError('The document name is not usable'))

    const response = await rename('doc-1', { displayName: '   ' })

    expect(response.status).toBe(400)
  })

  it('maps a NotFoundError to a 404', async () => {
    vi.mocked(renameDocument).mockRejectedValue(new NotFoundError())

    const response = await rename('missing', { displayName: 'x.pdf' })

    expect(response.status).toBe(404)
  })

  it('maps a ForbiddenError to a 403 (a read-only Archiv member)', async () => {
    vi.mocked(renameDocument).mockRejectedValue(new ForbiddenError())

    const response = await rename('doc-1', { displayName: 'x.pdf' })

    expect(response.status).toBe(403)
  })
})
