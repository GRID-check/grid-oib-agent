/**
 * @vitest-environment node
 *
 * The agent's way to a building's BYTES.
 *
 * This route hands over a credential — a presigned URL for the raw `.ifc` —
 * to a caller holding a service token and no session, which makes it the most
 * consequential of the two internal BIM routes. The assertions below are the
 * ones that keep it from being a wider door than `POST /api/internal/bim/query`:
 * the same `ifc-models` gate, the same project + Archiv scope, the same refusal
 * to treat a model that is still extracting as one that can be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory statically imports the session guard, which pulls in
// authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

vi.mock('@/lib/bim/repository', () => ({ listBimModels: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))
vi.mock('@/lib/s3', () => ({ s3Client: { send: vi.fn() }, bucketName: 'grid-documents' }))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }))

import { POST } from './route'
import { listBimModels, type BimModelHeader } from '@/lib/bim/repository'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client } from '@/lib/s3'

const PROJECT = '44444444-4444-4444-4444-444444444444'

const model = (over: Partial<BimModelHeader> & Pick<BimModelHeader, 'id' | 'filename'>): BimModelHeader => ({
  documentId: `doc-${over.id}`,
  projectId: PROJECT,
  status: 'ready',
  schemaVersion: 'IFC4',
  elementCount: 12,
  errorMessage: null,
  summary: null,
  searchKeysIndexed: true,
  updatedAt: new Date('2026-05-04T09:30:15.400Z'),
  ...over,
})

const NEW = model({ id: '11111111-1111-1111-1111-111111111111', filename: 'Haus-A_V3.ifc' })
const OLD = model({ id: '22222222-2222-2222-2222-222222222222', filename: 'Haus-A_V2.ifc' })

const post = (body: unknown): Promise<Response> =>
  POST(
    new Request('http://localhost/api/internal/bim/source', {
      method: 'POST',
      headers: { 'x-grid-internal-token': 'test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

describe('POST /api/internal/bim/source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
    delete process.env.GRID_IFC_MODELS_ENABLED
    vi.mocked(listBimModels).mockResolvedValue([NEW, OLD])
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
    vi.mocked(findDocumentInOrg).mockResolvedValue({
      id: 'doc-1',
      storageKey: 'org/org-1/project/p/doc/d/Haus-A_V3.ifc',
      storageBucket: null,
    } as never)
    vi.mocked(s3Client.send).mockResolvedValue({ ContentLength: 2_300_000, ETag: '"abc123"' } as never)
    vi.mocked(getSignedUrl).mockResolvedValue('http://seaweedfs:8333/grid-documents/…?X-Amz-Signature=…')
  })

  it('rejects a request without the service token', async () => {
    const denied = await POST(
      new Request('http://localhost/api/internal/bim/source', {
        method: 'POST',
        body: JSON.stringify({ organizationId: 'org-1', projectId: PROJECT, modelName: 'V3' }),
      })
    )
    expect(denied.status).toBe(403)
    expect(getSignedUrl).not.toHaveBeenCalled()
  })

  it('hands back a presigned URL and the content identity for the named model', async () => {
    const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelName: 'V3' })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.resolved).toBe(true)
    expect(body.model).toMatchObject({ filename: 'Haus-A_V3.ifc', modelId: NEW.id })
    // The ETag and the revision timestamp are what let the caller keep a parsed
    // model across turns without downloading the file again to find out it
    // already has it — and what stops it serving a re-export out of that cache.
    expect(body.source).toMatchObject({ etag: 'abc123', bytes: 2_300_000 })
    expect(body.model.updatedAt).toBe('2026-05-04T09:30:15.400Z')
    expect(body.source.url).toContain('X-Amz-Signature')
  })

  it('still serves the file when the store will not answer a HEAD', async () => {
    // The size and the ETag are hints. A store that refuses the probe must not
    // cost the agent the model.
    vi.mocked(s3Client.send).mockRejectedValue(new Error('no such method'))

    const body = await (await post({ organizationId: 'org-1', projectId: PROJECT, modelName: 'V3' })).json()

    expect(body.resolved).toBe(true)
    expect(body.source).toMatchObject({ etag: null, bytes: null })
  })

  describe('the ifc-models feature flag', () => {
    it('refuses when the organization does not have the feature', async () => {
      // The same gate as the query route, evaluated the same way. A second tool
      // that answered after the flag was revoked would make withdrawing the
      // feature meaningless.
      process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
      vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)

      const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelName: 'V3' })

      expect(response.status).toBe(403)
      expect(getSignedUrl).not.toHaveBeenCalled()
    })

    it('refuses when the deployment withdrew the feature', async () => {
      process.env.GRID_IFC_MODELS_ENABLED = 'false'

      const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelName: 'V3' })

      expect(response.status).toBe(403)
      expect(getSignedUrl).not.toHaveBeenCalled()
    })
  })

  describe('what it will not resolve', () => {
    it('scopes the model list to the conversation’s project and the Archiv', async () => {
      await post({ organizationId: 'org-1', projectId: PROJECT, modelName: 'V3' })

      expect(vi.mocked(listBimModels).mock.calls[0][1]).toMatchObject({
        projectId: PROJECT,
        includeArchiv: true,
      })
    })

    it('refuses a body that names neither a project nor a model', async () => {
      // The same requirement the query route states. Without it the model list
      // would be resolved with an UNDEFINED projectId, which `listBimModels`
      // reads as "no project predicate at all" — every model in the
      // organization, including projects the conversation holds no grant on.
      const response = await post({ organizationId: 'org-1', modelName: 'V3' })

      expect(response.status).toBe(400)
      expect(listBimModels).not.toHaveBeenCalled()
    })

    it('reports an ambiguous name rather than picking one', async () => {
      const body = await (await post({ organizationId: 'org-1', projectId: PROJECT, modelName: 'Haus-A' })).json()

      expect(body).toMatchObject({ resolved: false, reason: 'ambiguous' })
      expect(getSignedUrl).not.toHaveBeenCalled()
    })

    it('reports a model that is still being read as not ready, not as absent', async () => {
      vi.mocked(listBimModels).mockResolvedValue([model({ ...NEW, status: 'extracting' })])

      const body = await (await post({ organizationId: 'org-1', projectId: PROJECT })).json()

      expect(body).toMatchObject({ resolved: false, reason: 'not_ready' })
      expect(getSignedUrl).not.toHaveBeenCalled()
    })

    it('404s a modelId that is not in this organization', async () => {
      const response = await post({
        organizationId: 'org-1',
        projectId: PROJECT,
        modelId: '99999999-9999-9999-9999-999999999999',
      })

      expect(response.status).toBe(404)
      expect(getSignedUrl).not.toHaveBeenCalled()
    })

    it('404s a model whose document has no stored object', async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(null)

      const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelName: 'V3' })

      expect(response.status).toBe(404)
      expect(getSignedUrl).not.toHaveBeenCalled()
    })
  })
})
