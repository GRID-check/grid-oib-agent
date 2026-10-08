/**
 * @vitest-environment node
 *
 * A model under a folder the session is not cleared for does not exist for it
 * (ADR-0084).
 *
 * Every user-facing BIM surface authorizes through the model's DOCUMENT: the
 * header, the element query, the presigned URL to the raw IFC, the
 * document-model route and the project's model list. Before this, all of them
 * checked the project and nothing finer, so a project viewer could list, query
 * and download a model filed under a folder they cannot even see. Restricted
 * folders now refuse IFC models outright (`lib/projects/ifc-folder-guard.ts`);
 * these paths are what keeps a model filed there before that refusal hidden.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '@/lib/db/schema'

vi.mock('@/lib/authz/feature-flags', () => ({
  FEATURE_FLAGS: { ifcModels: 'ifc-models' },
  isFeatureEnabled: vi.fn().mockReturnValue(true),
  isIfcModelsEnabled: vi.fn().mockReturnValue(true),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => ({ role: 'member' })) }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())

const documents = new Map<string, Document>()
vi.mock('@/lib/documents/repository', () => ({
  findDocumentInOrg: vi.fn(async (documentId: string) => documents.get(documentId) ?? null),
}))

const MODEL = {
  id: 'model-1',
  documentId: 'doc-1',
  projectId: 'project-a',
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
  findBimModelById: vi.fn(async (modelId: string) => ({ ...MODEL, id: modelId, documentId: `doc-of-${modelId}` })),
  findBimModelByDocument: vi.fn(async (documentId: string) => ({ ...MODEL, documentId })),
  listBimModels: vi.fn(async () => [MODEL]),
  listBimCheckConfirmations: vi.fn(async () => []),
  upsertBimCheckConfirmation: vi.fn(),
  deleteBimCheckConfirmation: vi.fn(),
}))
vi.mock('./query', () => ({ runBimQuery: vi.fn(async () => ({ op: 'overview' })) }))
vi.mock('@/lib/s3', () => ({ s3Client: { send: vi.fn(async () => ({})) }, signingS3Client: {}, bucketName: 'grid-documents' }))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://s3.example/presigned') }))

import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getHiddenFolderIds, isFolderVisibleTo } from '@/lib/authz/folder-access'
import { NotFoundError } from '@/lib/api/errors'
import { makeDocument } from '@/test-utils/db-fixtures'
import { listBimModels } from './repository'
import { runBimQuery } from './query'
import {
  exportAccessibleComplianceBcf,
  getAccessibleModel,
  getModelForDocument,
  getModelSource,
  listAccessibleModels,
  queryAccessibleModel,
} from './model-service'

const SESSION = {
  userId: 'user-1',
  email: 'intern@example.at',
  name: null,
  accessToken: 't',
  organizationId: 'org-1',
  role: 'member',
  permissions: [],
  featureFlags: null,
} as unknown as Parameters<typeof getAccessibleModel>[0]

const HIDDEN_FOLDER = 'folder-verwaltung'

beforeEach(() => {
  documents.clear()
  const filed = (id: string, folderId: string | null) =>
    documents.set(id, makeDocument({ id, scope: 'project', projectId: 'project-a', folderId, storageKey: `k/${id}.ifc` }))
  filed('doc-of-model-hidden', HIDDEN_FOLDER)
  filed('doc-of-model-open', null)
  filed('doc-hidden', HIDDEN_FOLDER)
  // The intern is not cleared for Verwaltung; everything else is open.
  vi.mocked(isFolderVisibleTo).mockImplementation(async (_session, _project, folderId) => folderId !== HIDDEN_FOLDER)
  vi.mocked(getHiddenFolderIds).mockResolvedValue([HIDDEN_FOLDER])
})

describe('a model in a folder the session is not cleared for is not found', () => {
  it('GET /api/bim/models/[id] — the header', async () => {
    await expect(getAccessibleModel(SESSION, 'model-hidden')).rejects.toBeInstanceOf(NotFoundError)
    expect(isFolderVisibleTo).toHaveBeenCalledWith(SESSION, 'project-a', HIDDEN_FOLDER)
  })

  it('GET /api/bim/models/[id]/source — no presigned URL to the raw IFC', async () => {
    await expect(getModelSource(SESSION, 'model-hidden')).rejects.toBeInstanceOf(NotFoundError)
    expect(getSignedUrl).not.toHaveBeenCalled()
  })

  it('POST /api/bim/models/[id]/query — no element data', async () => {
    await expect(queryAccessibleModel(SESSION, 'model-hidden', { op: 'overview' })).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(runBimQuery).not.toHaveBeenCalled()
  })

  it('POST /api/bim/models/[id]/query — not as the base of a comparison either', async () => {
    await expect(
      queryAccessibleModel(SESSION, 'model-open', { op: 'compare', baseModelId: 'model-hidden' } as never)
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(runBimQuery).not.toHaveBeenCalled()
  })

  it('GET /api/documents/[id]/model', async () => {
    await expect(getModelForDocument(SESSION, 'doc-hidden')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('serves a model outside every hidden folder as before', async () => {
    await expect(getAccessibleModel(SESSION, 'model-open')).resolves.toMatchObject({ id: 'model-open' })
    await expect(getModelSource(SESSION, 'model-open')).resolves.toMatchObject({ url: 'https://s3.example/presigned' })
  })
})

describe('listings leave a hidden folder’s models out', () => {
  it('GET /api/projects/[id]/bim/models passes the hidden folders to the query', async () => {
    await listAccessibleModels(SESSION, 'project-a')
    expect(getHiddenFolderIds).toHaveBeenCalledWith(SESSION, 'project-a')
    expect(listBimModels).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ projectId: 'project-a', hiddenFolderIds: [HIDDEN_FOLDER] })
    )
  })

  it('the BCF export resolves a model by name only among the visible ones', async () => {
    await exportAccessibleComplianceBcf(SESSION, 'project-a', {
      modelId: null,
      modelName: 'Haus-A.ifc',
      gebaeudeklasse: null,
      hauptnutzung: null,
    }).catch(() => undefined)
    expect(listBimModels).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ projectId: 'project-a', hiddenFolderIds: [HIDDEN_FOLDER] })
    )
  })
})
