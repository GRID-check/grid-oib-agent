/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

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

import { GET } from './route'
import type { getDb as getDbType } from '@/lib/db'

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
})
