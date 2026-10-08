/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// An open project: no folder of it is restricted (ADR-0084).
vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
  }),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/s3', () => ({
  s3Client: {},
  // Browser-facing presigned URLs are signed with the public-endpoint client.
  signingS3Client: {},
  bucketName: 'grid-documents',
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://seaweedfs.test/preview-url'),
}))

// The converter itself is `rendition.spec.ts`'s subject. Here only its two
// outcomes and its switch are driven, with the real error classes, so what is
// under test is how the route answers each.
vi.mock('@/lib/documents/rendition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/rendition')>()),
  isRenditionEnabled: vi.fn().mockReturnValue(true),
  ensureRendition: vi.fn(),
}))

import { GET } from './route'
import type { getDb as getDbType } from '@/lib/db'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { RenditionFailedError, ensureRendition, isRenditionEnabled } from '@/lib/documents/rendition'

/**
 * A drizzle query-builder stand-in: this route only walks
 * `select().from().where().limit()`, so the stub implements that chain and the
 * assertion stays confined here.
 */
const asDb = (stub: Record<string, unknown>): ReturnType<typeof getDbType> =>
  stub as unknown as ReturnType<typeof getDbType>

describe('GET /api/documents/[id]/preview', () => {
  it('returns 404 for non-existent document', async () => {
    const { getDb } = await import('@/lib/db')
    vi.mocked(getDb).mockReturnValue(
      asDb({
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      })
    )

    const response = await GET(
      new Request('https://grid.test/api/documents/doc-1/preview') as unknown as NextRequest,
      { params: Promise.resolve({ id: 'doc-1' }) }
    )
    expect(response.status).toBe(404)
  })

  it('returns presigned URL for PDF documents', async () => {
    const { getDb } = await import('@/lib/db')
    vi.mocked(getDb).mockReturnValue(
      asDb({
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            storageKey: 'org/org-1/project/proj-1/doc/doc-1/plan.pdf',
            contentType: 'application/pdf',
            filename: 'plan.pdf',
            organizationId: 'org-1',
            projectId: 'proj-1',
            // NOT NULL with a 'project' default in the schema; the item routes
            // authorize per SHELF (ADR-0047 Phase 2), so a row without it is
            // unattributable rather than a project document.
            scope: 'project',
          },
        ]),
      })
    )

    const response = await GET(
      new Request('https://grid.test/api/documents/doc-1/preview') as unknown as NextRequest,
      { params: Promise.resolve({ id: 'doc-1' }) }
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveProperty('url')
    expect(body.contentType).toBe('application/pdf')
  })

  it('returns 415 for unsupported content types', async () => {
    const { getDb } = await import('@/lib/db')
    vi.mocked(getDb).mockReturnValue(
      asDb({
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            storageKey: 'org/org-1/project/proj-1/doc/doc-1/archive.zip',
            contentType: 'application/zip',
            filename: 'archive.zip',
            organizationId: 'org-1',
            projectId: 'proj-1',
            // NOT NULL with a 'project' default in the schema; the item routes
            // authorize per SHELF (ADR-0047 Phase 2), so a row without it is
            // unattributable rather than a project document.
            scope: 'project',
          },
        ]),
      })
    )

    const response = await GET(
      new Request('https://grid.test/api/documents/doc-1/preview') as unknown as NextRequest,
      { params: Promise.resolve({ id: 'doc-1' }) }
    )
    expect(response.status).toBe(415)
  })

  describe('an office document (ADR-0070)', () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const DOCX_ROW = {
      storageKey: 'org/org-1/project/proj-1/doc/doc-1/v1/Baubeschreibung.docx',
      contentType: DOCX,
      filename: 'Baubeschreibung.docx',
      organizationId: 'org-1',
      projectId: 'proj-1',
      scope: 'project',
    }
    const RENDITION_KEY = 'org/org-1/project/proj-1/doc/doc-1/v1/_render.pdf'

    const withRow = async (row: Record<string, unknown>) => {
      const { getDb } = await import('@/lib/db')
      vi.mocked(getDb).mockReturnValue(
        asDb({
          select: vi.fn().mockReturnThis(),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([row]),
        })
      )
    }
    const call = () =>
      GET(new Request('https://grid.test/api/documents/doc-1/preview') as unknown as NextRequest, {
        params: Promise.resolve({ id: 'doc-1' }),
      })

    beforeEach(() => {
      vi.mocked(getSignedUrl).mockClear()
      vi.mocked(isRenditionEnabled).mockReturnValue(true)
      vi.mocked(ensureRendition).mockReset().mockResolvedValue(RENDITION_KEY)
    })

    it('presigns the PDF rendition, never the original', async () => {
      await withRow(DOCX_ROW)

      const response = await call()
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        url: 'https://seaweedfs.test/preview-url',
        contentType: 'application/pdf',
        rendition: true,
        sourceContentType: DOCX,
        imageUrl: null,
      })
      const [, command] = vi.mocked(getSignedUrl).mock.calls[0]
      expect((command as { input: Record<string, unknown> }).input).toMatchObject({
        Key: RENDITION_KEY,
        ResponseContentType: 'application/pdf',
      })
      expect(String((command as { input: Record<string, unknown> }).input.ResponseContentDisposition)).toContain(
        'Baubeschreibung.pdf'
      )
    })

    it('recognises an office file by its extension when the stored type is empty', async () => {
      await withRow({ ...DOCX_ROW, contentType: null, filename: 'Kostenschaetzung.xlsx' })

      const response = await call()
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ rendition: true, sourceContentType: null })
    })

    it('is the 415 it always was when conversion is not configured', async () => {
      vi.mocked(isRenditionEnabled).mockReturnValue(false)
      await withRow(DOCX_ROW)

      const response = await call()
      expect(response.status).toBe(415)
      expect(ensureRendition).not.toHaveBeenCalled()
    })

    it('is a 502 RENDITION_FAILED when the converter fails', async () => {
      vi.mocked(ensureRendition).mockRejectedValue(new RenditionFailedError('Office conversion answered 503'))
      await withRow(DOCX_ROW)

      const response = await call()
      expect(response.status).toBe(502)
      expect((await response.json()).code).toBe('RENDITION_FAILED')
    })

    it('leaves a PDF exactly as it was, marked as no rendition', async () => {
      await withRow({ ...DOCX_ROW, contentType: 'application/pdf', filename: 'plan.pdf', storageKey: 'org/org-1/project/proj-1/doc/doc-1/plan.pdf' })

      const response = await call()
      expect(await response.json()).toMatchObject({ contentType: 'application/pdf', rendition: false, sourceContentType: null })
      expect(ensureRendition).not.toHaveBeenCalled()
    })
  })
})
