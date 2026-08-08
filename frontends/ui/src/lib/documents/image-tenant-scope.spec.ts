/**
 * @vitest-environment node
 */

/**
 * The signed image route has no session, and must still run inside a scope.
 *
 * `/api/documents/[id]/image` is `publicApiRoute` by necessity: the Next image
 * optimizer fetches it through an in-process request carrying no headers, so no
 * session cookie can reach it. Its route factory opens a tenant slot like every
 * other, but nothing ever FILLS that slot — there is no session to publish one.
 * The organization comes from the HMAC claim on the URL instead.
 *
 * That makes this the one path where the entry-point fix cannot help, and where
 * the repository stating its own scope is load-bearing rather than
 * belt-and-braces: with an unscoped `findDocumentInOrg`, every image request
 * threw `MissingTenantContextError` once row-level security was enforced, which
 * is why previews and thumbnails went blank across the app.
 *
 * So this test asserts the thing that actually matters: the query runs inside a
 * scope, and that scope is the organization the SIGNATURE claims — not one
 * inherited from whoever happened to call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asDb, makeDocument } from '@/test-utils/db-fixtures'

/** The context in force when the document query resolved. */
let observedScope: unknown

/** A real `Document` row — a schema change must break this test, not slip past it. */
const IMAGE_DOCUMENT = makeDocument({
  id: 'doc-1',
  organizationId: 'org-from-signature',
  storageKey: 'org/proj/doc-1/plan.png',
  contentType: 'image/png',
  filename: 'plan.png',
})

/**
 * A drizzle stand-in that records the tenant context when the query resolves.
 *
 * The row comes from `makeDocument`, so it is a real `Document` and a schema
 * change breaks this test rather than sliding past it; `asDb` is the repo's one
 * audited place where a hand-built query builder widens to the database handle.
 * Awaiting is where a real query demands a context, so that is where the
 * observation is taken.
 */
vi.mock('@/lib/db', () => ({
  getDb: () => {
    const chain: Record<string | symbol, unknown> = {}
    const proxy: unknown = new Proxy(chain, {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown) => {
            observedScope = getTenantContext()
            return Promise.resolve([IMAGE_DOCUMENT]).then(resolve)
          }
        }
        return () => proxy
      },
    })
    return asDb(proxy as Record<string, unknown>)
  },
}))

vi.mock('@/lib/db/schema', () => ({ documents: { id: 'id', organizationId: 'organization_id' } }))

// Everything off this path, mocked so the module graph does not drag in WorkOS
// or the projects domain: the signed URL is the authorization here, and the
// only question under test is the scope the document query runs in.
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }))
vi.mock('@/lib/documents/vlm-capability', () => ({ isVlmConfigured: vi.fn() }))
vi.mock('./reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn() }))

// Clients doubled, key builders real. The thumbnail rule was previously
// re-implemented here as `${key}.thumb.jpg` — a shape production has never
// written, since the real builder REPLACES the filename segment with
// `_thumb.jpg`. A spec that invents its own key cannot notice the day the
// production one changes.
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: vi.fn().mockResolvedValue({ Body: { transformToWebStream: () => new ReadableStream() } }) },
  signingS3Client: { send: vi.fn() },
  bucketAdminS3Client: { send: vi.fn() },
  bucketName: 'test-bucket',
}))

// The signature itself is covered by `signed-image-url.spec.ts`; here it is a
// given, so the test is about what happens AFTER a URL is accepted.
vi.mock('@/lib/images/signed-image-url', () => ({
  verifyDocumentImageUrl: () => ({
    ok: true,
    claims: { organizationId: 'org-from-signature', documentId: 'doc-1', variant: 'original', exp: 0 },
  }),
  buildDocumentImageUrl: () => null,
}))

import { getTenantContext, runWithTenantSlot } from '@/lib/db/tenant-context'
import { streamDocumentImage } from './service'

describe('the signed image route runs in a scope without a session', () => {
  beforeEach(() => {
    observedScope = 'not-observed'
  })

  it('queries inside the organization the signature claims, and leaves no scope behind', async () => {
    // An EMPTY slot and no session — exactly the state the image optimizer's
    // headerless request arrives in.
    const { response, scopeAfterStream } = await runWithTenantSlot(async () => {
      const response = await streamDocumentImage(
        'doc-1',
        new URLSearchParams({ org: 'org-from-signature', v: 'original' }),
      )
      // Read INSIDE the slot: a check from another test would be outside every
      // scope and could not see a context this call had left behind.
      return { response, scopeAfterStream: getTenantContext() }
    })

    expect(response.status).toBe(200)
    expect(observedScope).toEqual({
      kind: 'tenant',
      organizationId: 'org-from-signature',
      userId: null,
    })
    // The repository's scope covers its own query and no more — and the two
    // readings differing is what shows the recorder can tell the states apart.
    expect(scopeAfterStream).toBeUndefined()
  })
})
