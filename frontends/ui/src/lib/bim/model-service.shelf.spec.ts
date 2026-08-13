/**
 * @vitest-environment node
 *
 * Who may look at a model, per shelf.
 *
 * A model is derived data; the DOCUMENT it was read from is the thing the
 * sharing rules are written about. `getAccessibleModel` and
 * `getModelForDocument` used to encode that as "a document with no project is
 * the org-wide Archiv, and any member may read it", which was an exact
 * statement of the rules until a second project-less shelf existed.
 *
 * ADR-0047 Phase 2 built one: a file dropped into a chat is `scope = 'session'`
 * with a NULL project, and it reaches the same extraction dispatcher — so a
 * private chat attachment became a model that every member of the organization
 * could read the building out of, and mint a presigned URL for. The documents
 * domain closed the same hole in `getAccessibleDocument`; these two entry
 * points had not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '@/lib/db/schema'

vi.mock('@/lib/authz/feature-flags', () => ({
  FEATURE_FLAGS: { ifcModels: 'ifc-models' },
  isFeatureEnabled: vi.fn().mockReturnValue(true),
  isIfcModelsEnabled: vi.fn().mockReturnValue(true),
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

/** `conv-mine` is a chat the caller is in; every other conversation 404s. */
vi.mock('@/lib/sharing/access', () => ({
  requireResourceAccess: vi.fn(
    async (_session: unknown, _type: string, resourceId: string) => {
      if (resourceId !== 'conv-mine') {
        const { NotFoundError } = await import('@/lib/api/errors')
        throw new NotFoundError()
      }
      return { role: 'viewer' }
    }
  ),
}))

const documentsByShelf = new Map<string, Document>()

vi.mock('@/lib/documents/repository', () => ({
  findDocumentInOrg: vi.fn(async (documentId: string) => documentsByShelf.get(documentId) ?? null),
}))

const MODEL = {
  id: 'model-1',
  documentId: 'doc-1',
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
  findBimModelById: vi.fn(async (modelId: string) => ({ ...MODEL, id: modelId })),
  findBimModelByDocument: vi.fn(async (documentId: string) => ({ ...MODEL, documentId })),
  listBimModels: vi.fn().mockResolvedValue([]),
  listBimCheckConfirmations: vi.fn().mockResolvedValue([]),
  upsertBimCheckConfirmation: vi.fn(),
  deleteBimCheckConfirmation: vi.fn(),
}))

vi.mock('./query', () => ({ runBimQuery: vi.fn() }))

import { makeDocument } from '@/test-utils/db-fixtures'
import { getAccessibleModel, getModelForDocument } from './model-service'

const SESSION = {
  userId: 'user-1',
  email: 'member@example.at',
  name: null,
  accessToken: 't',
  organizationId: 'org-1',
  permissions: [],
  featureFlags: null,
} as unknown as Parameters<typeof getAccessibleModel>[0]

beforeEach(() => {
  documentsByShelf.clear()
  documentsByShelf.set(
    'doc-archiv',
    makeDocument({ id: 'doc-archiv', scope: 'archiv', projectId: null, collectionName: 'archiv_org-1' })
  )
  documentsByShelf.set(
    'doc-project',
    makeDocument({ id: 'doc-project', scope: 'project', projectId: 'project-a' })
  )
  documentsByShelf.set(
    'doc-other-project',
    makeDocument({ id: 'doc-other-project', scope: 'project', projectId: 'project-b' })
  )
  documentsByShelf.set(
    'doc-my-chat',
    makeDocument({
      id: 'doc-my-chat',
      scope: 'session',
      projectId: null,
      conversationId: 'conv-mine',
      collectionName: 'conv-mine',
    })
  )
  documentsByShelf.set(
    'doc-other-chat',
    makeDocument({
      id: 'doc-other-chat',
      scope: 'session',
      projectId: null,
      conversationId: 'conv-theirs',
      collectionName: 'conv-theirs',
    })
  )
})

describe('getModelForDocument', () => {
  it('lets any member of the organization read an Archiv model', async () => {
    // The Archiv is shared knowledge by design (ADR-0024) — and this is the
    // path the Archiv's own file preview resolves its viewport through.
    await expect(getModelForDocument(SESSION, 'doc-archiv')).resolves.toMatchObject({
      documentId: 'doc-archiv',
    })
  })

  it('keeps per-project FGA on a project model', async () => {
    await expect(getModelForDocument(SESSION, 'doc-project')).resolves.toBeTruthy()
    await expect(getModelForDocument(SESSION, 'doc-other-project')).rejects.toThrow()
  })

  it('refuses a chat attachment to somebody outside that chat', async () => {
    // The regression. A `session` document also has a NULL project, so the old
    // "no project means the Archiv" test handed a private attachment to the
    // whole organization.
    await expect(getModelForDocument(SESSION, 'doc-other-chat')).rejects.toThrow()
  })

  it('still serves a chat attachment inside its own chat', async () => {
    await expect(getModelForDocument(SESSION, 'doc-my-chat')).resolves.toBeTruthy()
  })
})

describe('getAccessibleModel', () => {
  it('applies the same shelf rules when the model is addressed by id', async () => {
    documentsByShelf.set(
      'doc-1',
      makeDocument({
        id: 'doc-1',
        scope: 'session',
        projectId: null,
        conversationId: 'conv-theirs',
        collectionName: 'conv-theirs',
      })
    )
    // Addressing the model directly must not be a way around the document's
    // own rule — this is the id the query, source and compliance routes take.
    await expect(getAccessibleModel(SESSION, 'model-1')).rejects.toThrow()

    documentsByShelf.set('doc-1', makeDocument({ id: 'doc-1', scope: 'archiv', projectId: null }))
    await expect(getAccessibleModel(SESSION, 'model-1')).resolves.toMatchObject({ id: 'model-1' })
  })

  it('treats a project row with no project as corrupt rather than org-wide', async () => {
    documentsByShelf.set('doc-1', makeDocument({ id: 'doc-1', scope: 'project', projectId: null }))

    await expect(getAccessibleModel(SESSION, 'model-1')).rejects.toThrow()
  })
})
