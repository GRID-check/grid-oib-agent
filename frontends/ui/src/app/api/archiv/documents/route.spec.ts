/**
 * @vitest-environment node
 *
 * The Archiv listing is a project's listing on another shelf (ADR-0078): the
 * same query parameters and the same wire row, so the browser maps both with one
 * function. This suite pins the two halves of that — the parameters reach the
 * service, and the row that leaves is `toDocumentWireRow`'s, field for field.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'member',
    permissions: [],
    featureFlags: null,
  }),
}))

vi.mock('@/lib/archiv/service', () => ({ listArchiv: vi.fn() }))
vi.mock('@/lib/documents/lifecycle', () => ({
  summarizeDocumentVersions: vi.fn().mockResolvedValue(new Map([['d1', { versionCount: 2, state: 'published' }]])),
}))

import { listArchiv } from '@/lib/archiv/service'
import { toDocumentWireRow } from '@/lib/documents/list-projection'
import type { ListedDocument } from '@/lib/documents/shelf-listing'
import { GET } from './route'

const LISTED: ListedDocument = {
  id: 'd1',
  filename: 'norm.pdf',
  displayName: null,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'completed',
  authoredBy: 'user',
  publishedVersionId: null,
  lifecycle: 'active',
  collectionName: 'archiv_org-1',
  folderId: 'folder-1',
  originPath: 'Normen/norm.pdf',
  contentHash: 'sha256:abc',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
  errorMessage: null,
  assignees: [],
}

const get = (query = '') => GET(new NextRequest(`https://grid.test/api/archiv/documents${query}`), { params: Promise.resolve({}) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listArchiv).mockResolvedValue({
    documents: [LISTED],
    nextCursor: null,
    collectionName: 'archiv_org-1',
    canManage: true,
  })
})

describe('GET /api/archiv/documents', () => {
  it('serves the same wire row a project listing serves, field for field', async () => {
    const body = await (await get()).json()

    // `toDocumentWireRow` is what `/api/documents` serializes through: the Archiv
    // row must be that, folderId, originPath, authoredBy, lifecycle,
    // versionState/versionCount and contentHash included.
    const expected = JSON.parse(
      JSON.stringify(toDocumentWireRow(LISTED, { versionCount: 2, state: 'published' })),
    )
    expect(body.documents[0]).toEqual(expected)
    expect(body.documents[0]).toMatchObject({
      folderId: 'folder-1',
      originPath: 'Normen/norm.pdf',
      authoredBy: 'user',
      lifecycle: 'active',
      versionState: 'published',
      versionCount: 2,
      contentHash: 'sha256:abc',
    })
  })

  it('keeps the envelope the Archiv browser reads', async () => {
    const body = await (await get()).json()

    expect(body).toMatchObject({ nextCursor: null, collectionName: 'archiv_org-1', canManage: true })
  })

  it('defaults to the working set and forwards no author filter', async () => {
    await get()

    expect(listArchiv).toHaveBeenCalledWith(expect.anything(), {
      authoredBy: undefined,
      includeArchived: false,
      cursor: undefined,
    })
  })

  it('forwards ?includeArchived=true and ?authoredBy=agent', async () => {
    await get('?includeArchived=true&authoredBy=agent')

    expect(listArchiv).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeArchived: true, authoredBy: 'agent' }),
    )
  })

  it('refuses an author the column cannot hold, rather than listing nothing', async () => {
    const response = await get('?authoredBy=robot')

    expect(response.status).toBe(400)
    expect(listArchiv).not.toHaveBeenCalled()
  })

  it('refuses includeArchived with any value but true', async () => {
    expect((await get('?includeArchived=1')).status).toBe(400)
  })
})
