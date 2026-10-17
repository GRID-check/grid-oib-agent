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
vi.mock('@/lib/documents/listed-document', () => ({ getListedDocument: vi.fn() }))
vi.mock('@/lib/documents/lifecycle', () => ({
  summarizeDocumentVersions: vi.fn().mockResolvedValue(new Map([['doc-1', { versionCount: 3, state: 'published' }]])),
}))

import { deleteDocument, renameDocument } from '@/lib/documents/service'
import { getListedDocument } from '@/lib/documents/listed-document'
import { toDocumentWireRow } from '@/lib/documents/list-projection'
import type { ListedDocument } from '@/lib/documents/shelf-listing'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { DELETE, GET, PATCH } from './route'

const LISTED: ListedDocument = {
  id: 'doc-1',
  filename: 'plan.pdf',
  displayName: null,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'completed',
  authoredBy: 'user',
  publishedVersionId: null,
  lifecycle: 'active',
  collectionName: 'proj_c',
  folderId: null,
  originPath: null,
  contentHash: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
  errorMessage: null,
  quarantine: null,
  assignees: [],
}

const read = (id: string) =>
  GET(new Request(`https://grid.test/api/documents/${id}`) as unknown as NextRequest, {
    params: Promise.resolve({ id }),
  })

// A link to a document the paged Files level has not loaded (ADR-0102).
describe('GET /api/documents/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it("answers with the row the shelf's listing would carry, version state included", async () => {
    vi.mocked(getListedDocument).mockResolvedValue(LISTED)

    const response = await read('doc-1')

    expect(response.status).toBe(200)
    expect((await response.json()).document).toEqual(
      JSON.parse(JSON.stringify(toDocumentWireRow(LISTED, { versionCount: 3, state: 'published' }))),
    )
    expect(getListedDocument).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'doc-1')
  })

  it('maps a document the reader may not see to a 404', async () => {
    vi.mocked(getListedDocument).mockRejectedValue(new NotFoundError())
    expect((await read('held-1')).status).toBe(404)
  })
})

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
