/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/documents/service', () => ({
  findDocumentStorageKey: vi.fn(),
  findDocumentImageStorageKey: vi.fn(),
}))

vi.mock('@/lib/conversations/restricted-use', () => ({
  drawableRestrictedCollections: vi.fn(),
}))

// Partial: the factory opens a request-scoped slot itself, and replacing that
// would test a handler the app does not run.
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
}))

import { GET } from './route'
import { drawableRestrictedCollections } from '@/lib/conversations/restricted-use'
import { withTenant } from '@/lib/db/tenant-context'
import { findDocumentImageStorageKey, findDocumentStorageKey } from '@/lib/documents/service'
import { GRID_HEADER_NAMES, buildGridRequestContextEnvelope } from '@/lib/request-context'

const request = (
  query = '?collection=proj_1&filename=plan.png',
  token: string | null = 'test-token',
  headers: Record<string, string> = {}
): Request =>
  new Request(`http://localhost/api/internal/document-file${query}`, {
    headers: { ...(token ? { 'x-grid-internal-token': token } : {}), ...headers },
  })

const RESTRICTED = 'proj_1_r0123456789ab'
const WRONG_SECRET = 'not-the-signing-secret' // pragma: allowlist secret

/** The turn's signed envelope, as the BFF mints it and the agent echoes it. */
function envelope(
  overrides: { collectionScope?: string[]; conversationId?: string | null; secret?: string } = {}
): Record<string, string> {
  const { header, signature } = buildGridRequestContextEnvelope(
    {
      organizationId: 'org_1',
      userId: 'user_asker',
      projectId: 'p1',
      collectionScope: overrides.collectionScope ?? ['oib_knowledge', 'proj_1'],
      ...(overrides.conversationId === null ? {} : { conversationId: overrides.conversationId ?? 's_conv_1' }),
      issuedAt: Date.now(),
    },
    overrides.secret ?? 'test-token'
  )
  return {
    [GRID_HEADER_NAMES.REQUEST_CONTEXT]: header,
    [GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]: signature ?? '',
  }
}

const STORED = { storageKey: 'org/o1/project/p1/doc/d1/plan.png', storageBucket: null, contentType: 'image/png' }

describe('GET /api/internal/document-file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await GET(request('?collection=proj_1&filename=plan.png', null))).status).toBe(403)
    expect((await GET(request('?collection=proj_1&filename=plan.png', 'wrong'))).status).toBe(403)
    expect(findDocumentStorageKey).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await GET(request())).status).toBe(503)
  })

  it('400s when collection or filename is missing/empty', async () => {
    expect((await GET(request('?filename=plan.png'))).status).toBe(400)
    expect((await GET(request('?collection=proj_1'))).status).toBe(400)
    expect((await GET(request('?collection=&filename=plan.png'))).status).toBe(400)
    expect(findDocumentStorageKey).not.toHaveBeenCalled()
  })

  it('404s when the document index has no row for the pair', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue(null)
    const res = await GET(request())
    expect(res.status).toBe(404)
    expect(vi.mocked(findDocumentStorageKey).mock.calls[0]).toEqual(['proj_1', 'plan.png', undefined])
  })

  it('forwards organizationId to the service when the query param is present', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue({
      storageKey: 'org/o1/archiv/doc/d1/plan.png',
      storageBucket: null,
      contentType: 'image/png',
    })
    const res = await GET(request('?collection=archiv_org_1&filename=plan.png&organizationId=org_1'))
    expect(res.status).toBe(200)
    expect(vi.mocked(findDocumentStorageKey).mock.calls[0]).toEqual(['archiv_org_1', 'plan.png', 'org_1'])
  })

  it('passes no organizationId to the service when the query param is absent', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue(null)
    await GET(request())
    expect(vi.mocked(findDocumentStorageKey).mock.calls[0][2]).toBeUndefined()
  })

  it('returns the storage key, its bucket and the content type for a known document', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue({
      storageKey: 'org/o1/project/p1/doc/d1/plan.png',
      storageBucket: null,
      contentType: 'image/png',
    })
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      storageKey: 'org/o1/project/p1/doc/d1/plan.png',
      storageBucket: null,
      contentType: 'image/png',
    })
  })

  // The agent tier calls get_object directly, so the bucket has to travel with
  // the key. A response that dropped it would send every per-organization
  // lookup to the shared bucket, where the object is not — a silent 404 that
  // degrades to a text-only answer with nothing in any log to explain it.
  it('passes a per-organization bucket through to the caller', async () => {
    vi.mocked(findDocumentStorageKey).mockResolvedValue({
      storageKey: 'org/o1/project/p1/doc/d1/plan.png',
      storageBucket: 'grid-org-o1-abcdef123456',
      contentType: 'image/png',
    })
    const res = await GET(request())
    expect(await res.json()).toMatchObject({ storageBucket: 'grid-org-o1-abcdef123456' })
  })

  // The derived-key read. The backend only ever varies a bounded integer; the
  // key itself is built from the document's row, so it cannot leave the prefix.
  describe('with imageIndex', () => {
    it('resolves the stored raster through the image lookup, not the file lookup', async () => {
      vi.mocked(findDocumentImageStorageKey).mockResolvedValue({
        storageKey: 'org/o1/project/p1/doc/d1/_img/2.jpg',
        storageBucket: null,
        contentType: 'image/jpeg',
      })
      const res = await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=2'))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        storageKey: 'org/o1/project/p1/doc/d1/_img/2.jpg',
        storageBucket: null,
        contentType: 'image/jpeg',
      })
      expect(vi.mocked(findDocumentImageStorageKey).mock.calls[0]).toEqual(['proj_1', 'plan.pdf', 2, undefined])
      expect(findDocumentStorageKey).not.toHaveBeenCalled()
    })

    it('404s when the document or the index is unknown', async () => {
      vi.mocked(findDocumentImageStorageKey).mockResolvedValue(null)
      expect((await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=99'))).status).toBe(404)
    })

    it('400s a negative or non-integer index before any lookup', async () => {
      expect((await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=-1'))).status).toBe(400)
      expect((await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=1.5'))).status).toBe(400)
      expect((await GET(request('?collection=proj_1&filename=plan.pdf&imageIndex=abc'))).status).toBe(400)
      expect(findDocumentImageStorageKey).not.toHaveBeenCalled()
    })
  })

  // ADR-0088: the collection is the model's argument, so its name is not a
  // boundary. The envelope the agent echoes is.
  describe("with the turn's signed envelope", () => {
    beforeEach(() => {
      vi.mocked(findDocumentStorageKey).mockResolvedValue(STORED)
      vi.mocked(drawableRestrictedCollections).mockResolvedValue([])
    })

    it('answers for a collection the envelope signs, in the organization it names', async () => {
      const res = await GET(request('?collection=proj_1&filename=plan.png', 'test-token', envelope()))
      expect(res.status).toBe(200)
      expect(vi.mocked(withTenant).mock.calls[0][0]).toEqual({ organizationId: 'org_1' })
      expect(vi.mocked(findDocumentStorageKey).mock.calls[0]).toEqual(['proj_1', 'plan.png', 'org_1'])
    })

    it('404s a collection outside the signed scope, before any lookup', async () => {
      const res = await GET(request('?collection=proj_other&filename=plan.png', 'test-token', envelope()))
      expect(res.status).toBe(404)
      expect(findDocumentStorageKey).not.toHaveBeenCalled()
    })

    it('404s a query naming another organization than the envelope', async () => {
      const res = await GET(
        request('?collection=proj_1&filename=plan.png&organizationId=org_2', 'test-token', envelope())
      )
      expect(res.status).toBe(404)
      expect(findDocumentStorageKey).not.toHaveBeenCalled()
    })

    it('401s an envelope that does not verify, rather than falling back to the name', async () => {
      const res = await GET(
        request('?collection=proj_1&filename=plan.png', 'test-token', envelope({ secret: WRONG_SECRET }))
      )
      expect(res.status).toBe(401)
      expect(findDocumentStorageKey).not.toHaveBeenCalled()
    })

    it('answers for a restricted folder the asker and the audience may read now', async () => {
      vi.mocked(drawableRestrictedCollections).mockResolvedValue([RESTRICTED])
      const headers = envelope({ collectionScope: ['proj_1', RESTRICTED] })
      const res = await GET(request(`?collection=${RESTRICTED}&filename=gehalt.png`, 'test-token', headers))
      expect(res.status).toBe(200)
      expect(vi.mocked(drawableRestrictedCollections).mock.calls[0]).toEqual([
        { organizationId: 'org_1', conversationId: 's_conv_1', userId: 'user_asker', projectId: 'p1' },
        [RESTRICTED],
      ])
    })

    it('404s a restricted folder the asker lost read on, though the scope still signs it', async () => {
      vi.mocked(drawableRestrictedCollections).mockResolvedValue([])
      const headers = envelope({ collectionScope: ['proj_1', RESTRICTED] })
      const query = `?collection=${RESTRICTED}&filename=gehalt.png&imageIndex=0`
      const res = await GET(request(query, 'test-token', headers))
      expect(res.status).toBe(404)
      expect(findDocumentStorageKey).not.toHaveBeenCalled()
      expect(findDocumentImageStorageKey).not.toHaveBeenCalled()
    })

    it('404s a restricted folder in an envelope with no conversation to admit it in', async () => {
      const headers = envelope({ collectionScope: ['proj_1', RESTRICTED], conversationId: null })
      const res = await GET(request(`?collection=${RESTRICTED}&filename=gehalt.png`, 'test-token', headers))
      expect(res.status).toBe(404)
      expect(drawableRestrictedCollections).not.toHaveBeenCalled()
      expect(findDocumentStorageKey).not.toHaveBeenCalled()
    })
  })

  describe('without an envelope', () => {
    it('never answers for a restricted folder, in either spelling', async () => {
      vi.mocked(findDocumentStorageKey).mockResolvedValue(STORED)
      expect((await GET(request(`?collection=${RESTRICTED}&filename=gehalt.png`))).status).toBe(404)
      expect((await GET(request(`?collection=${RESTRICTED.toUpperCase()}&filename=gehalt.png`))).status).toBe(404)
      expect(findDocumentStorageKey).not.toHaveBeenCalled()
      expect(drawableRestrictedCollections).not.toHaveBeenCalled()
    })
  })
})
