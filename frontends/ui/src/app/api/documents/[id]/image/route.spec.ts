/**
 * The signed image route is the ONLY document route that serves bytes without a
 * session, so these tests are the gate on that decision: an unsigned, forged,
 * cross-tenant or non-image request must not get bytes back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// The session resolver is stubbed to THROW rather than to return a user. The
// route factory pulls AuthKit into the module graph either way, but this way
// every passing test below also proves the route never consulted a session —
// which is the whole premise of serving it to a cookie-less optimizer fetch.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(() => {
    throw new Error('the signed image route must not require a session')
  }),
}))

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

vi.mock('@/lib/s3', () => ({
  s3Client: { send: vi.fn() },
  signingS3Client: {},
  bucketName: 'grid-documents',
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://seaweedfs.test/presigned'),
}))

import { GET } from './route'
import { s3Client } from '@/lib/s3'
import { buildDocumentImageUrl } from '@/lib/images/signed-image-url'
import type { getDb as getDbType } from '@/lib/db'

const ORG = 'org-1'
const DOC = 'doc-1'

const asDb = (stub: Record<string, unknown>): ReturnType<typeof getDbType> =>
  stub as unknown as ReturnType<typeof getDbType>

/** Stub the single `select().from().where().limit()` walk the lookup performs. */
async function stubDocument(row: Record<string, unknown> | null) {
  const { getDb } = await import('@/lib/db')
  vi.mocked(getDb).mockReturnValue(
    asDb({
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(row ? [row] : []),
    })
  )
}

const imageRow = {
  storageKey: `org/${ORG}/project/proj-1/doc/${DOC}/site.png`,
  contentType: 'image/png',
  filename: 'site.png',
  organizationId: ORG,
  projectId: 'proj-1',
}

function call(query: string) {
  return GET(
    new Request(`https://grid.test/api/documents/${DOC}/image${query}`) as unknown as NextRequest,
    { params: Promise.resolve({ id: DOC }) }
  )
}

/** The query half of a genuinely minted URL. */
function signedQuery(documentId = DOC, variant: 'original' | 'thumb' = 'original') {
  const url = buildDocumentImageUrl(ORG, documentId, variant)
  if (!url) throw new Error('signing unexpectedly disabled')
  return url.slice(url.indexOf('?'))
}

describe('GET /api/documents/[id]/image', () => {
  beforeEach(() => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'test-signing-secret')
    vi.mocked(s3Client.send).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('streams the image for a validly signed URL', async () => {
    await stubDocument(imageRow)
    vi.mocked(s3Client.send).mockResolvedValue({
      Body: { transformToWebStream: () => new ReadableStream() },
    } as never)

    const response = await call(signedQuery())

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('refuses an unsigned request', async () => {
    await stubDocument(imageRow)

    const response = await call('')

    expect(response.status).toBe(403)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('refuses a forged signature', async () => {
    await stubDocument(imageRow)

    const response = await call(signedQuery().replace(/sig=[0-9a-f]+/, 'sig=' + 'a'.repeat(64)))

    expect(response.status).toBe(403)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('refuses a signature minted for a different document', async () => {
    await stubDocument(imageRow)

    // A token the caller legitimately holds for doc-2, replayed against doc-1.
    const response = await call(signedQuery('doc-2'))

    expect(response.status).toBe(403)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('refuses a signature whose org claim was tampered with', async () => {
    await stubDocument(imageRow)

    const response = await call(signedQuery().replace(/org=[^&]+/, 'org=org-2'))

    expect(response.status).toBe(403)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('scopes the row lookup to the SIGNED org, not the requested one', async () => {
    // The document exists, but not in the org the token was minted for: the
    // tenancy filter in the query returns nothing and the route 404s.
    await stubDocument(null)
    const response = await call(signedQuery())

    expect(response.status).toBe(404)
  })

  it('does not serve a non-image document even with a valid signature', async () => {
    // Defence in depth: a token minted while the row was an image must not
    // become a download channel if the row is later a PDF.
    await stubDocument({ ...imageRow, contentType: 'application/pdf', filename: 'plan.pdf' })

    const response = await call(signedQuery())

    expect(response.status).toBe(404)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('serves the thumbnail object as JPEG for the thumb variant', async () => {
    await stubDocument(imageRow)
    vi.mocked(s3Client.send).mockResolvedValue({
      Body: { transformToWebStream: () => new ReadableStream() },
    } as never)

    const response = await call(signedQuery(DOC, 'thumb'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    const command = vi.mocked(s3Client.send).mock.calls[0]![0] as unknown as {
      input: { Key: string }
    }
    expect(command.input.Key).toBe(`org/${ORG}/project/proj-1/doc/${DOC}/_thumb.jpg`)
  })

  it('404s when the thumbnail object was never generated', async () => {
    await stubDocument(imageRow)
    vi.mocked(s3Client.send).mockRejectedValue(new Error('NoSuchKey'))

    const response = await call(signedQuery(DOC, 'thumb'))

    expect(response.status).toBe(404)
  })

  it('is disabled rather than open when no signing secret is configured', async () => {
    const query = signedQuery()
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    await stubDocument(imageRow)

    const response = await call(query)

    expect(response.status).toBe(503)
    expect(s3Client.send).not.toHaveBeenCalled()
  })
})
