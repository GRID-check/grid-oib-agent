/**
 * @vitest-environment node
 *
 * A quarantined IFC's model (ADR-0083).
 *
 * The IFC digest is screened like any upload, but the model is extracted
 * BEFORE the digest is dispatched, so a file held back for its content still
 * has a `ready` model. The model surfaces do not pass `getAccessibleDocument`:
 * the header, the element query and the presigned source URL authorize through
 * `assertDocumentReadable`, and the agent's `ifc_query` / `ifc_measure` through
 * `resolveInternalModel`. Each must hold the file back exactly as the document
 * routes do.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/feature-flags', () => ({
  FEATURE_FLAGS: { ifcModels: 'ifc-models' },
  enforcementOn: vi.fn().mockReturnValue(false),
  ifcModelsEnvEnabled: vi.fn().mockReturnValue(true),
  isFeatureEnabled: vi.fn().mockReturnValue(true),
  isIfcModelsEnabled: vi.fn().mockReturnValue(true),
}))
vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/organizations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/organizations')>()),
  canManageArchiv: vi.fn(() => false),
}))
vi.mock('@/lib/documents/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/repository')>()),
  findDocumentInOrg: vi.fn(),
}))

const MODEL = {
  id: 'model-1',
  documentId: 'doc-q',
  projectId: null,
  filename: 'Haus-A.ifc',
  displayName: null,
  status: 'ready' as const,
  schemaVersion: 'IFC4',
  elementCount: 10,
  errorMessage: null,
  summary: null,
  searchKeysIndexed: false,
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
}

vi.mock('./repository', () => ({
  findBimModelById: vi.fn(async () => MODEL),
  findBimModelByDocument: vi.fn(async () => MODEL),
  listBimModels: vi.fn().mockResolvedValue([]),
  listBimCheckConfirmations: vi.fn().mockResolvedValue([]),
  upsertBimCheckConfirmation: vi.fn(),
  deleteBimCheckConfirmation: vi.fn(),
}))
vi.mock('./query', () => ({ runBimQuery: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canManageArchiv } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { makeDocument } from '@/test-utils/db-fixtures'
import { resolveInternalModel } from './internal-access'
import { getAccessibleModel, getModelForDocument, listAccessibleModels } from './model-service'
import { listBimModels } from './repository'

const personOf = (userId: string): AuthorizedSession =>
  ({ organizationId: 'org-1', userId, email: `${userId}@example.at`, permissions: [] }) as unknown as AuthorizedSession

const member = personOf('member-1')
const uploader = personOf('uploader-1')

const quarantinedArchivIfc = (): Document =>
  makeDocument({
    id: 'doc-q',
    scope: 'archiv',
    projectId: null,
    filename: 'Haus-A.ifc',
    createdBy: 'uploader-1',
    status: 'quarantined',
    errorMessage: 'quarantined:{"reasons":[{"kind":"term","term":"Honorar"}]}',
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findDocumentInOrg).mockResolvedValue(quarantinedArchivIfc())
  vi.mocked(canManageArchiv).mockReturnValue(false)
  vi.mocked(requireProjectAccess).mockImplementation(async (_session, _projectId, permission) => {
    if (permission === 'project:manage') throw new NotFoundError('Project not found')
    return { role: 'project-viewer' } as Awaited<ReturnType<typeof requireProjectAccess>>
  })
})

describe('the model of a quarantined IFC', () => {
  it('does not exist for a member who did not upload it', async () => {
    await expect(getAccessibleModel(member, 'model-1')).rejects.toBeInstanceOf(NotFoundError)
    await expect(getModelForDocument(member, 'doc-q')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('is served to its uploader and to a curator of the Büroablage', async () => {
    await expect(getAccessibleModel(uploader, 'model-1')).resolves.toMatchObject({ id: 'model-1' })
    vi.mocked(canManageArchiv).mockReturnValue(true)
    await expect(getAccessibleModel(member, 'model-1')).resolves.toMatchObject({ id: 'model-1' })
  })

  it("is left out of a member's model list", async () => {
    await listAccessibleModels(member, 'proj-1')
    expect(vi.mocked(listBimModels).mock.calls[0][1]?.quarantineReaders).toEqual({
      project: 'member-1',
      archiv: 'member-1',
    })
  })

  // The list spans the project and the Büroablage, and each shelf has its own
  // reviewers: one reader for both showed a project admin every quarantined
  // Büroablage model, and hid them from a curator who reviews them.
  it('asks each shelf its own reviewer rule', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' } as Awaited<
      ReturnType<typeof requireProjectAccess>
    >)
    await listAccessibleModels(member, 'proj-1')
    expect(vi.mocked(listBimModels).mock.calls[0][1]?.quarantineReaders).toEqual({
      project: undefined,
      archiv: 'member-1',
    })

    vi.mocked(requireProjectAccess).mockImplementation(async (_session, _projectId, permission) => {
      if (permission === 'project:manage') throw new NotFoundError('Project not found')
      return { role: 'project-viewer' } as Awaited<ReturnType<typeof requireProjectAccess>>
    })
    vi.mocked(canManageArchiv).mockReturnValue(true)
    await listAccessibleModels(member, 'proj-1')
    expect(vi.mocked(listBimModels).mock.calls[1][1]?.quarantineReaders).toEqual({
      project: 'member-1',
      archiv: undefined,
    })
  })

  it("is never resolved for the agent's IFC tools", async () => {
    await expect(resolveInternalModel({ organizationId: 'org-1', modelId: 'model-1' })).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(vi.mocked(listBimModels).mock.calls[0][1]).toMatchObject({ withoutQuarantined: true })
  })
})
