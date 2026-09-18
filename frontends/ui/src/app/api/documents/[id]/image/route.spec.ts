/**
 * @vitest-environment node
 */
/**
 * The signed image route is the ONLY document route that serves bytes without a
 * session, so these tests are the gate on that decision — with one twist: the
 * route never refuses with an error status. Its only consumer is the Next
 * image optimizer, whose internal fetch ignores status codes and sniffs every
 * non-empty body as image bytes, so a 403/404 JSON envelope became "isn't a
 * valid image … received null" (#366). Every failure therefore deflects to a
 * static placeholder image (200); the gate below asserts the deflection carries
 * no tenant bytes, and that an unsigned, forged, cross-tenant or non-image
 * request still never reaches the object store.
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

// Only the CLIENTS are doubled. The key builders come through as the real
// thing (`importOriginal`) so this spec exercises the production key
// composition rather than a fixture's idea of it — the `_thumb.jpg` assertion
// below is only worth anything if the key under test is the one production
// would build.
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: vi.fn() },
  signingS3Client: {},
  bucketAdminS3Client: { send: vi.fn() },
  bucketName: 'grid-documents',
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://seaweedfs.test/presigned'),
}))

import { GET } from './route'
import { s3Client } from '@/lib/s3'
import { buildDocumentImageUrl } from '@/lib/images/signed-image-url'
import { fallbackImageBytes } from '@/lib/images/image-fallback'
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

/**
 * The deflection contract: a 200 carrying exactly the static placeholder
 * bytes — sniffable by the optimizer, and provably not tenant content.
 */
async function expectPlaceholder(response: Response): Promise<void> {
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('image/png')
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(fallbackImageBytes())
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
      // ContentLength is always present on a real GetObject response; the
      // empty-object guard reads it, so the mock carries it like S3 does.
      ContentLength: 48211,
      Body: { transformToWebStream: () => new ReadableStream() },
    } as never)

    const response = await call(signedQuery())

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('deflects an unsigned request to the placeholder instead of a 403', async () => {
    // The optimizer cannot ingest an error body (see the module comment), so
    // every refusal is a 200 with static bytes — and still never touches the
    // object store, so no tenant bytes can leak through this path.
    await stubDocument(imageRow)

    const response = await call('')

    await expectPlaceholder(response)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('deflects a forged signature to the placeholder', async () => {
    await stubDocument(imageRow)

    const response = await call(signedQuery().replace(/sig=[0-9a-f]+/, 'sig=' + 'a'.repeat(64)))

    await expectPlaceholder(response)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('deflects a signature minted for a different document to the placeholder', async () => {
    await stubDocument(imageRow)

    // A token the caller legitimately holds for doc-2, replayed against doc-1.
    const response = await call(signedQuery('doc-2'))

    await expectPlaceholder(response)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('deflects a signature whose org claim was tampered with to the placeholder', async () => {
    await stubDocument(imageRow)

    const response = await call(signedQuery().replace(/org=[^&]+/, 'org=org-2'))

    await expectPlaceholder(response)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('deflects an expired signature to the placeholder instead of a 403 (#366)', async () => {
    // The proven replay: tabs outlive the 1–2h token window (production saw
    // fetches hours to days past `exp`), and the 403 JSON those met became
    // "isn't a valid image … received null" on every render.
    await stubDocument(imageRow)
    const stale = buildDocumentImageUrl(ORG, DOC, 'thumb', Date.now() - 3 * 3600_000)
    if (!stale) throw new Error('signing unexpectedly disabled')

    const response = await call(stale.slice(stale.indexOf('?')))

    await expectPlaceholder(response)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('scopes the row lookup to the SIGNED org, not the requested one', async () => {
    // The document exists, but not in the org the token was minted for: the
    // tenancy filter in the query returns nothing, which deflects rather than
    // 404s — the lookup still ran inside the signed org's scope.
    await stubDocument(null)
    const response = await call(signedQuery())

    await expectPlaceholder(response)
  })

  it('does not serve a non-image document even with a valid signature', async () => {
    // Defence in depth: a token minted while the row was an image must not
    // become a download channel if the row is later a PDF.
    await stubDocument({ ...imageRow, contentType: 'application/pdf', filename: 'plan.pdf' })

    const response = await call(signedQuery())

    await expectPlaceholder(response)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('serves the thumbnail object as JPEG for the thumb variant', async () => {
    await stubDocument(imageRow)
    vi.mocked(s3Client.send).mockResolvedValue({
      ContentLength: 48211,
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

  it('deflects a missing thumbnail object to the placeholder', async () => {
    // A publish or delete racing the card render: the mint-side HEAD passed,
    // but the object is gone by the time the optimizer fetches.
    await stubDocument(imageRow)
    vi.mocked(s3Client.send).mockRejectedValue(new Error('NoSuchKey'))

    const response = await call(signedQuery(DOC, 'thumb'))

    await expectPlaceholder(response)
  })

  it('deflects an empty thumbnail object to the placeholder (#366)', async () => {
    // A failed ingest render can leave a 0-byte object in the slot: it exists,
    // so it is not a NoSuchKey, but it decodes to nothing.
    await stubDocument(imageRow)
    vi.mocked(s3Client.send).mockResolvedValue({ ContentLength: 0, Body: undefined } as never)

    const response = await call(signedQuery(DOC, 'thumb'))

    await expectPlaceholder(response)
  })

  it('streams the bytes when the gateway omits ContentLength (#366)', async () => {
    // The emptiness guard used to read a missing header as a missing object
    // (`?? 0`), deflecting a perfectly good thumbnail. Decide from the bytes.
    await stubDocument(imageRow)
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    vi.mocked(s3Client.send).mockResolvedValue({
      Body: {
        transformToWebStream: () =>
          new ReadableStream({ start: (controller) => controller.enqueue(jpeg) }),
        transformToByteArray: () => Promise.resolve(jpeg),
      },
    } as never)

    const response = await call(signedQuery(DOC, 'thumb'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg)
  })

  it('deflects an unreadable body without ContentLength to the placeholder', async () => {
    await stubDocument(imageRow)
    vi.mocked(s3Client.send).mockResolvedValue({
      Body: {
        transformToWebStream: () => new ReadableStream(),
        transformToByteArray: () => Promise.resolve(new Uint8Array(0)),
      },
    } as never)

    const response = await call(signedQuery(DOC, 'thumb'))

    await expectPlaceholder(response)
  })

  it('deflects to the placeholder rather than going open when no signing secret is configured', async () => {
    const query = signedQuery()
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    await stubDocument(imageRow)

    const response = await call(query)

    await expectPlaceholder(response)
    expect(s3Client.send).not.toHaveBeenCalled()
  })
})
