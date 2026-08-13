/**
 * @vitest-environment node
 *
 * The agent's way into a building.
 *
 * Everything the user-facing routes do to keep a model inside its tenant and
 * its project has to be done again here, because this route carries a service
 * token instead of a session and therefore shares none of that machinery. Two
 * of those checks were missing, and both failed in the direction that answers
 * a question it should have refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory statically imports the session guard, which pulls in
// authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

vi.mock('@/lib/bim/repository', () => ({ listBimModels: vi.fn() }))
vi.mock('@/lib/bim/query', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bim/query')>('@/lib/bim/query')
  return { ...actual, runBimQuery: vi.fn() }
})
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))

import { POST } from './route'
import { listBimModels } from '@/lib/bim/repository'
import { runBimQuery } from '@/lib/bim/query'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import type { BimModelHeader } from '@/lib/bim/repository'

const PROJECT = '44444444-4444-4444-4444-444444444444'

const model = (over: Partial<BimModelHeader> & Pick<BimModelHeader, 'id' | 'filename'>): BimModelHeader => ({
  documentId: `doc-${over.id}`,
  displayName: null,
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
/** Same organization, a project this conversation holds no grant on. */
const OTHER_PROJECT = '33333333-3333-3333-3333-333333333333'

const post = (body: unknown): Promise<Response> =>
  POST(
    new Request('http://localhost/api/internal/bim/query', {
      method: 'POST',
      headers: { 'x-grid-internal-token': 'test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

describe('POST /api/internal/bim/query', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
    delete process.env.GRID_IFC_MODELS_ENABLED
    vi.mocked(listBimModels).mockResolvedValue([NEW, OLD])
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
    vi.mocked(runBimQuery).mockResolvedValue({
      op: 'overview',
      model: { id: NEW.id, filename: NEW.filename, schema: 'IFC4', elementCount: 12 },
      summary: 'ok',
    })
  })

  it('rejects a request without the service token', async () => {
    const denied = await POST(
      new Request('http://localhost/api/internal/bim/query', {
        method: 'POST',
        body: JSON.stringify({ organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } }),
      })
    )
    expect(denied.status).toBe(403)
    expect(runBimQuery).not.toHaveBeenCalled()
  })

  describe('the ifc-models feature flag', () => {
    it('answers when the organization has the feature', async () => {
      process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
      const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } })

      expect(response.status).toBe(200)
      expect(isOrgFeatureEnabled).toHaveBeenCalledWith('ifc-models', 'org-1')
    })

    it('refuses when the organization does not', async () => {
      // The gate covered the upload and the pages but not this route, so
      // revoking the flag left the agent answering questions about the
      // building for as long as anyone kept asking.
      process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
      vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)

      const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } })

      expect(response.status).toBe(403)
      expect(runBimQuery).not.toHaveBeenCalled()
    })

    it('answers without enforcement, which is the default', async () => {
      // No flag lookup is attempted — there is no flag product to ask.
      const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } })

      expect(response.status).toBe(200)
      expect(isOrgFeatureEnabled).not.toHaveBeenCalled()
    })

    it('refuses without enforcement when the deployment withdrew the feature', async () => {
      // The route reads the same switch as the UI. Turning the feature off
      // must stop the AGENT answering questions about the building too — that
      // gap is what let it keep answering after the flag was revoked.
      process.env.GRID_IFC_MODELS_ENABLED = 'false'

      const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } })

      expect(response.status).toBe(403)
      expect(runBimQuery).not.toHaveBeenCalled()
      expect(isOrgFeatureEnabled).not.toHaveBeenCalled()
    })
  })

  describe('the base model of a two-revision op', () => {
    it('resolves `compare` from the file name, within the project', async () => {
      await post({
        organizationId: 'org-1',
        projectId: PROJECT,
        modelId: NEW.id,
        query: { op: 'compare', limit: 20000 },
        compareWithName: 'V2',
      })

      expect(vi.mocked(runBimQuery).mock.calls[0][0]).toMatchObject({
        op: 'compare',
        baseModelId: OLD.id,
      })
    })

    it('resolves `compliance-diff` the same way', async () => {
      // It did not: the route only handled `compare`, so a diff arrived with
      // whatever base the caller named and `runBimQuery` scoped it to the
      // organization alone.
      await post({
        organizationId: 'org-1',
        projectId: PROJECT,
        modelId: NEW.id,
        query: { op: 'compliance-diff' },
        compareWithName: 'V2',
      })

      expect(vi.mocked(runBimQuery).mock.calls[0][0]).toMatchObject({
        op: 'compliance-diff',
        baseModelId: OLD.id,
      })
    })

    for (const op of ['compare', 'compliance-diff'] as const) {
      it(`discards a \`${op}\` baseModelId supplied in the body`, async () => {
        // Another project's building, in the same organization. The diff would
        // report every one of its elements as `removed` — name, type and
        // storey — for a project the caller holds no grant on.
        await post({
          organizationId: 'org-1',
          projectId: PROJECT,
          modelId: NEW.id,
          query: { op, baseModelId: OTHER_PROJECT, ...(op === 'compare' ? { limit: 20000 } : {}) },
          compareWithName: 'V2',
        })

        expect(vi.mocked(runBimQuery).mock.calls[0][0]).toMatchObject({ baseModelId: OLD.id })
      })

      it(`refuses \`${op}\` when no counterpart is named`, async () => {
        const response = await post({
          organizationId: 'org-1',
          projectId: PROJECT,
          modelId: NEW.id,
          query: { op, baseModelId: OTHER_PROJECT, ...(op === 'compare' ? { limit: 20000 } : {}) },
        })

        expect(await response.json()).toMatchObject({ resolved: false, reason: 'compare_target_missing' })
        expect(runBimQuery).not.toHaveBeenCalled()
      })
    }

    it('refuses a counterpart that is not in the readable set', async () => {
      const response = await post({
        organizationId: 'org-1',
        projectId: PROJECT,
        modelId: NEW.id,
        query: { op: 'compliance-diff' },
        compareWithName: 'irgendwas-anderes',
      })

      expect(await response.json()).toMatchObject({ resolved: false, reason: 'no_match' })
      expect(runBimQuery).not.toHaveBeenCalled()
    })
  })
})
