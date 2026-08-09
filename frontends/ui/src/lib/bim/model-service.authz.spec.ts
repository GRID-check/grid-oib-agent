/**
 * @vitest-environment node
 *
 * Authorization of the SECOND model.
 *
 * `compare` and `compliance-diff` take a `baseModelId` from the request body.
 * The integration suite already proves the org boundary holds for it. Nothing
 * proved the PROJECT boundary did — and it did not: `runBimQuery` resolves the
 * base with `findBimModelById`, which scopes on the organization alone, while
 * every other model path goes through `getAccessibleModel` and its
 * per-project FGA check.
 *
 * A member with `project:view` on one project could therefore name any model
 * id in the organization as the base and read another project's building out
 * of the diff — element names and storeys from `compare`, per-rule verdict
 * counts and the file name from `compliance-diff`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/feature-flags', () => ({
  FEATURE_FLAGS: { ifcModels: 'ifc-models' },
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

/** `project-a` is granted; every other project 404s, as FGA does here. */
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(async (_session: unknown, projectId: string) => {
    if (projectId !== 'project-a') {
      const { NotFoundError } = await import('@/lib/api/errors')
      throw new NotFoundError('Project not found')
    }
    return { role: 'project-admin' }
  }),
}))

vi.mock('@/lib/documents/repository', () => ({
  findDocumentInOrg: vi.fn(async (documentId: string) => ({
    id: documentId,
    // `doc-a` belongs to the granted project; `doc-b` to a project the caller
    // has no grant on. Both are in the same organization.
    projectId: documentId === 'doc-a' ? 'project-a' : 'project-b',
    storageKey: 'k',
  })),
}))

vi.mock('./repository', () => ({
  findBimModelById: vi.fn(async (modelId: string) => ({
    id: modelId,
    documentId: modelId === 'model-a' ? 'doc-a' : 'doc-b',
    projectId: modelId === 'model-a' ? 'project-a' : 'project-b',
    filename: `${modelId}.ifc`,
    status: 'ready',
    schemaVersion: 'IFC4',
    elementCount: 10,
    errorMessage: null,
    summary: null,
    updatedAt: new Date('2026-05-04T00:00:00.000Z'),
  })),
  findBimModelByDocument: vi.fn(),
  listBimModels: vi.fn().mockResolvedValue([]),
  listBimCheckConfirmations: vi.fn().mockResolvedValue([]),
  upsertBimCheckConfirmation: vi.fn(),
  deleteBimCheckConfirmation: vi.fn(),
}))

vi.mock('./query', () => ({
  runBimQuery: vi.fn().mockResolvedValue({ comparison: { added: [], removed: [], changed: [] } }),
}))

import { queryAccessibleModel } from './model-service'
import { runBimQuery } from './query'

const SESSION = {
  userId: 'user-1',
  email: 'member@example.at',
  name: null,
  accessToken: 't',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'member',
  permissions: [],
  featureFlags: ['ifc-models'],
}

describe('queryAccessibleModel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses a base model in a project the caller has no grant on', async () => {
    // Without the second `getAccessibleModel`, this resolves and the response
    // carries `model-b`'s element names.
    await expect(
      queryAccessibleModel(SESSION, 'model-a', {
        op: 'compare',
        baseModelId: 'model-b',
        limit: 500,
      } as Parameters<typeof queryAccessibleModel>[2])
    ).rejects.toThrow(/not found/i)

    expect(runBimQuery).not.toHaveBeenCalled()
  })

  it('refuses a compliance diff against a project the caller cannot see', async () => {
    await expect(
      queryAccessibleModel(SESSION, 'model-a', {
        op: 'compliance-diff',
        baseModelId: 'model-b',
      } as Parameters<typeof queryAccessibleModel>[2])
    ).rejects.toThrow(/not found/i)

    expect(runBimQuery).not.toHaveBeenCalled()
  })

  it('still allows a base model inside the granted project', async () => {
    await queryAccessibleModel(SESSION, 'model-a', {
      op: 'compare',
      baseModelId: 'model-a',
      limit: 500,
    } as Parameters<typeof queryAccessibleModel>[2])

    expect(runBimQuery).toHaveBeenCalledTimes(1)
  })

  it('leaves ops without a second model alone', async () => {
    await queryAccessibleModel(SESSION, 'model-a', {
      op: 'overview',
    } as Parameters<typeof queryAccessibleModel>[2])

    expect(runBimQuery).toHaveBeenCalledTimes(1)
  })
})
