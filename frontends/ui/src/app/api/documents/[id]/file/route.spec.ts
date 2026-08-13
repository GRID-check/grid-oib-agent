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

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

const send = vi.hoisted(() => vi.fn())

vi.mock('@/lib/s3', () => ({
  s3Client: { send },
  signingS3Client: {},
  bucketName: 'grid-documents',
}))

import { GET } from './route'
import { getDb } from '@/lib/db'
import type { getDb as getDbType } from '@/lib/db'

/**
 * A drizzle query-builder stand-in: this route only walks
 * `select().from().where().limit()`, so the stub implements that chain and the
 * assertion stays confined here.
 */
const asDb = (stub: Record<string, unknown>): ReturnType<typeof getDbType> =>
  stub as unknown as ReturnType<typeof getDbType>

const withRow = (row: Record<string, unknown> | null): void => {
  vi.mocked(getDb).mockReturnValue(
    asDb({
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(row ? [row] : []),
    })
  )
}

const PDF_ROW = {
  storageKey: 'org/org-1/project/proj-1/doc/doc-1/plan.pdf',
  contentType: 'application/pdf',
  filename: 'Einreichplan Ostfassade.pdf',
  organizationId: 'org-1',
  projectId: 'proj-1',
  // NOT NULL with a 'project' default in the schema, so a row without it is a
  // row the database cannot produce. The item routes authorize per SHELF now
  // (ADR-0047 Phase 2) — an omitted scope is an unattributable document, and
  // this fixture is meant to stand for an ordinary project upload.
  scope: 'project',
}

const call = (): Promise<Response> =>
  GET(new Request('https://grid.test/api/documents/doc-1/file') as unknown as NextRequest, {
    params: Promise.resolve({ id: 'doc-1' }),
  })

beforeEach(() => {
  send.mockReset()
})

describe('GET /api/documents/[id]/file', () => {
  it('streams the stored bytes inline from this origin', async () => {
    withRow(PDF_ROW)
    send.mockResolvedValue({
      Body: { transformToWebStream: () => new ReadableStream() },
    })

    const response = await call()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toBe(
      'inline; filename="Einreichplan Ostfassade.pdf"'
    )
    // Tenant bytes must never reach a shared cache.
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300')
  })

  /**
   * This route exists so the viewer can FETCH a document same-origin; when
   * pdf.js cannot run it degrades to a same-origin iframe on the same URL. The
   * global next.config rule stamps `DENY` on every route, so without these the
   * fallback renders as a blank frame.
   */
  it('allows same-origin framing so the viewer fallback can render it', async () => {
    withRow(PDF_ROW)
    send.mockResolvedValue({ Body: { transformToWebStream: () => new ReadableStream() } })

    const response = await call()
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
  })

  it('is 404 for a document the session cannot reach', async () => {
    withRow(null)
    expect((await call()).status).toBe(404)
  })

  it('is 404 when the row carries no stored object', async () => {
    withRow({ ...PDF_ROW, storageKey: null })
    expect((await call()).status).toBe(404)
    // The object store must not even be consulted for a row with no key.
    expect(send).not.toHaveBeenCalled()
  })

  it('is 404 when the object is gone from the store', async () => {
    withRow(PDF_ROW)
    send.mockRejectedValue(new Error('NoSuchKey'))
    expect((await call()).status).toBe(404)
  })

  it('refuses a content type that is not a PDF', async () => {
    withRow({ ...PDF_ROW, contentType: 'application/zip', filename: 'archive.zip' })
    expect((await call()).status).toBe(415)
    expect(send).not.toHaveBeenCalled()
  })

  /**
   * The one that matters. `PREVIEW_CONTENT_TYPES` — the gate the presigned
   * preview uses — admits `image/svg+xml`, and an SVG is a script carrier:
   * served inline from THIS origin it would execute in the app's origin with
   * the user's session. Widening this route back to that list is stored XSS,
   * so the narrower gate is pinned here rather than left to a comment.
   */
  it('refuses an SVG, which would otherwise run script in this origin', async () => {
    withRow({ ...PDF_ROW, contentType: 'image/svg+xml', filename: 'logo.svg' })
    expect((await call()).status).toBe(415)
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a raster image — nothing needs to fetch image bytes same-origin', async () => {
    withRow({ ...PDF_ROW, contentType: 'image/png', filename: 'foto.png' })
    expect((await call()).status).toBe(415)
  })

  it('strips non-ASCII and quotes from the filename header', async () => {
    withRow({ ...PDF_ROW, filename: 'Gebäude"plan.pdf' })
    send.mockResolvedValue({ Body: { transformToWebStream: () => new ReadableStream() } })

    const response = await call()
    expect(response.headers.get('Content-Disposition')).toBe('inline; filename="Geb_ude_plan.pdf"')
  })
})
