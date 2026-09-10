/**
 * @vitest-environment node
 */
/**
 * The READ door: one version's bytes, for a turn whose subject retrieval cannot
 * see.
 *
 * What is asserted here is the boundary, not the happy path. The route is
 * addressed by a version id alone — no collection name, no session — so the
 * organization the caller states is the ONLY thing standing between this and a
 * cross-tenant read. It is therefore driven through the real
 * `readVersionForService`, with the repository and the object store as the
 * doubles: mocking the service instead would assert the mock's predicate.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory statically imports the session guard, which pulls in
// authkit; an internal route never calls it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

vi.mock('@/lib/documents/version-repository', () => ({
  findDocumentVersionInOrg: vi.fn(),
  // The rest of the module is imported by `lifecycle`; nothing here calls them.
  compareAndSwapVersionState: vi.fn(),
  findDocumentVersion: vi.fn(),
  listDocumentVersionSummaries: vi.fn(),
  findOpenVersion: vi.fn(),
  findPublishedVersion: vi.fn(),
  insertDocumentVersion: vi.fn(),
  listDocumentVersions: vi.fn(),
  nextVersionNumber: vi.fn(),
  promoteVersionToPublished: vi.fn(),
  setDocumentLifecycle: vi.fn(),
}))

vi.mock('@/lib/documents/repository', () => ({
  findDocumentInOrg: vi.fn(),
  findFolderPathInProject: vi.fn(),
}))

const send = vi.fn()
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: (...args: unknown[]) => send(...args) },
}))

vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
}))

import { findDocumentVersionInOrg } from '@/lib/documents/version-repository'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { withTenant } from '@/lib/db/tenant-context'
import { GET } from './route'

const VERSION = '22222222-2222-4222-8222-222222222222'
const DOCUMENT = '11111111-1111-4111-8111-111111111111'

const params = { params: Promise.resolve({ versionId: VERSION }) }

const request = (query = '?organizationId=org_1', token: string | null = 'test-token'): Request =>
  new Request(`http://localhost/api/internal/document-versions/${VERSION}/content${query}`, {
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

const version = {
  id: VERSION,
  documentId: DOCUMENT,
  organizationId: 'org_1',
  versionNumber: 3,
  state: 'in_review' as const,
  contentType: 'text/markdown',
  contentHash: 'hash-3',
  storageKey: 'org/o1/project/p1/doc/d1/v3/befund.md',
  storageBucket: null,
  fileSize: 42,
}

const document = { id: DOCUMENT, filename: 'piloti/doc-1/befund.md', displayName: 'Befund Fluchtwege' }

function versionExistsInOrg1(): void {
  vi.mocked(findDocumentVersionInOrg).mockImplementation(async (id: string, organizationId: string) =>
    id === VERSION && organizationId === 'org_1' ? (version as never) : null
  )
  vi.mocked(findDocumentInOrg).mockImplementation(async (id: string, organizationId: string) =>
    id === DOCUMENT && organizationId === 'org_1' ? (document as never) : null
  )
  send.mockResolvedValue({ Body: { transformToString: async () => '# Befund\n\nAbschnitt 3: GK 4.\n' } })
}

describe('GET /api/internal/document-versions/[versionId]/content', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
  })

  describe('the service token', () => {
    it('rejects a missing or wrong token before it reads anything', async () => {
      expect((await GET(request('?organizationId=org_1', null), params)).status).toBe(403)
      expect((await GET(request('?organizationId=org_1', 'wrong'), params)).status).toBe(403)
      expect(findDocumentVersionInOrg).not.toHaveBeenCalled()
    })

    it('fails closed when the token is unconfigured', async () => {
      delete process.env.GRID_INTERNAL_API_TOKEN
      expect((await GET(request(), params)).status).toBe(503)
    })
  })

  describe('tenancy', () => {
    it('400s without an organization, rather than reading unscoped', async () => {
      // A version id carries no scope of its own. This is the difference from
      // `/api/internal/document-file`, where an unguessable collection name is
      // the boundary and the organization is optional.
      expect((await GET(request(''), params)).status).toBe(400)
      expect((await GET(request('?organizationId='), params)).status).toBe(400)
      expect(findDocumentVersionInOrg).not.toHaveBeenCalled()
    })

    it('404s a version id belonging to another organization', async () => {
      versionExistsInOrg1()
      const res = await GET(request('?organizationId=org_2'), params)

      expect(res.status).toBe(404)
      // Indistinguishable from an id that never existed: the answer must not
      // tell a caller that somebody else's version is there.
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not found/i) })
      expect(vi.mocked(findDocumentVersionInOrg).mock.calls[0]).toEqual([VERSION, 'org_2'])
    })

    it('opens the tenant slot from the organization it was given', async () => {
      versionExistsInOrg1()
      await GET(request('?organizationId=org_1'), params)
      expect(vi.mocked(withTenant).mock.calls[0][0]).toEqual({ organizationId: 'org_1' })
    })

    it('404s when the version is there but its document is not this tenant’s', async () => {
      versionExistsInOrg1()
      vi.mocked(findDocumentInOrg).mockResolvedValue(null)
      expect((await GET(request(), params)).status).toBe(404)
    })
  })

  describe('what it answers with', () => {
    it('hands back the text plus what a filing record is made of', async () => {
      versionExistsInOrg1()
      const res = await GET(request(), params)

      expect(res.status).toBe(200)
      // The state and the hash travel WITH the bytes because the caller stamps
      // both onto the working-directory file it writes: without them a later
      // `file_draft` files a second document instead of replacing this version.
      expect(await res.json()).toEqual({
        documentId: DOCUMENT,
        versionId: VERSION,
        versionNumber: 3,
        state: 'in_review',
        contentHash: 'hash-3',
        contentType: 'text/markdown',
        filename: 'piloti/doc-1/befund.md',
        displayName: 'Befund Fluchtwege',
        content: '# Befund\n\nAbschnitt 3: GK 4.\n',
      })
    })

    it('404s when the object has no readable body', async () => {
      versionExistsInOrg1()
      send.mockResolvedValue({ Body: undefined })
      expect((await GET(request(), params)).status).toBe(404)
    })
  })
})
