/**
 * @vitest-environment node
 *
 * The rules a document-role declaration has to obey.
 *
 * The repository is mocked on purpose: what this layer owns is the vocabulary,
 * the scope check and cardinality, and mocking drizzle instead would test the
 * query builder rather than any of that. The SQL underneath is covered against
 * a real PostgreSQL by `scripts/rls-test-db.sh`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentRoleBinding } from './repository'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

const repo = vi.hoisted(() => ({
  bindings: [] as DocumentRoleBinding[],
  inserted: [] as Record<string, unknown>[],
  deleted: [] as string[],
  documentInProject: true,
}))

vi.mock('./repository', () => ({
  listProjectDocumentRoles: vi.fn(async () => repo.bindings),
  findBindingsForRole: vi.fn(async () => repo.bindings),
  documentBelongsToProject: vi.fn(async () => repo.documentInProject),
  insertBinding: vi.fn(async (input: Record<string, unknown>) => {
    repo.inserted.push(input)
    repo.bindings = [...repo.bindings, binding({ documentId: String(input.documentId) })]
    return 'new-binding'
  }),
  deleteBindings: vi.fn(async (_projectId: string, ids: readonly string[]) => {
    // Count what actually matched, as the real repository does via
    // `.returning()`. Returning `ids.length` unconditionally made the
    // "binding not found" case impossible to reach, so the test that
    // asserts it was testing this mock rather than the service.
    const matched = repo.bindings.filter((b) => ids.includes(b.id)).map((b) => b.id)
    repo.deleted.push(...matched)
    repo.bindings = repo.bindings.filter((b) => !ids.includes(b.id))
    return matched.length
  }),
}))

const { declareDocumentRole, revokeDocumentRole } = await import('./service')
const { requireProjectAccess } = await import('@/lib/authz/projects')

function binding(overrides: Partial<DocumentRoleBinding> = {}): DocumentRoleBinding {
  return {
    id: 'binding-1',
    projectId: 'proj-1',
    documentId: 'doc-1',
    role: 'bebauungsplan',
    scopeInstanceId: null,
    confidence: 'declared',
    source: 'user',
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    filename: 'bplan.pdf',
    displayName: null,
    ...overrides,
  }
}

const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession

beforeEach(() => {
  repo.bindings = []
  repo.inserted = []
  repo.deleted = []
  repo.documentInProject = true
  vi.clearAllMocks()
})

describe('declareDocumentRole', () => {
  it('refuses a role outside the vocabulary', async () => {
    await expect(
      declareDocumentRole({ projectId: 'proj-1', documentId: 'doc-1', role: 'bauplan' }, session)
    ).rejects.toThrow(/Unknown document role/)
    expect(repo.inserted).toHaveLength(0)
  })

  it('refuses a bauwerk role with no building', async () => {
    await expect(
      declareDocumentRole(
        { projectId: 'proj-1', documentId: 'doc-1', role: 'bestandsplan' },
        session
      )
    ).rejects.toThrow(/needs its id/)
  })

  it('refuses a project role that carries a building', async () => {
    await expect(
      declareDocumentRole(
        { projectId: 'proj-1', documentId: 'doc-1', role: 'vorbescheid', scopeInstanceId: 'bw1' },
        session
      )
    ).rejects.toThrow(/takes no scope instance/)
  })

  it('answers "not in this project" instead of letting the foreign key raise', async () => {
    repo.documentInProject = false
    await expect(
      declareDocumentRole({ projectId: 'proj-1', documentId: 'doc-9', role: 'lageplan' }, session)
    ).rejects.toThrow(/Document not found in this project/)
  })

  it('checks write permission before doing anything', async () => {
    await declareDocumentRole(
      { projectId: 'proj-1', documentId: 'doc-1', role: 'lageplan' },
      session
    )
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', [
      'project:documents:write',
      'project:edit',
    ])
  })

  it('records the declaration with its provenance', async () => {
    await declareDocumentRole(
      { projectId: 'proj-1', documentId: 'doc-1', role: 'lageplan' },
      session
    )
    expect(repo.inserted[0]).toMatchObject({
      organizationId: 'org-1',
      createdBy: 'user-1',
      role: 'lageplan',
      confidence: 'declared',
      source: 'user',
    })
  })

  it('lets a classifier suggest without claiming a person confirmed it', async () => {
    await declareDocumentRole(
      {
        projectId: 'proj-1',
        documentId: 'doc-1',
        role: 'lageplan',
        confidence: 'suggested',
        source: 'classifier',
      },
      session
    )
    expect(repo.inserted[0]).toMatchObject({ confidence: 'suggested', source: 'classifier' })
  })

  it('replaces the holder of a single-holder role and reports what it displaced', async () => {
    repo.bindings = [binding({ id: 'old', documentId: 'doc-old', filename: 'alt-bplan.pdf' })]
    const result = await declareDocumentRole(
      { projectId: 'proj-1', documentId: 'doc-new', role: 'bebauungsplan' },
      session
    )
    expect(repo.deleted).toEqual(['old'])
    expect(result.replaced.map((b) => b.filename)).toEqual(['alt-bplan.pdf'])
    expect(repo.inserted).toHaveLength(1)
  })

  it('keeps every sheet of a many-holder role', async () => {
    repo.bindings = [
      binding({ id: 'sheet-1', documentId: 'doc-a', role: 'bestandsplan', scopeInstanceId: 'bw1' }),
    ]
    const result = await declareDocumentRole(
      { projectId: 'proj-1', documentId: 'doc-b', role: 'bestandsplan', scopeInstanceId: 'bw1' },
      session
    )
    expect(repo.deleted).toEqual([])
    expect(result.replaced).toEqual([])
  })

  it('treats declaring the same binding twice as a no-op, not a unique violation', async () => {
    repo.bindings = [binding({ id: 'already', documentId: 'doc-1' })]
    const result = await declareDocumentRole(
      { projectId: 'proj-1', documentId: 'doc-1', role: 'bebauungsplan' },
      session
    )
    expect(result.binding.id).toBe('already')
    expect(result.replaced).toEqual([])
    expect(repo.inserted).toHaveLength(0)
    expect(repo.deleted).toEqual([])
  })
})

describe('revokeDocumentRole', () => {
  it('reports a binding that was not there rather than succeeding quietly', async () => {
    await expect(revokeDocumentRole('proj-1', 'missing', session)).rejects.toThrow(/not found/)
  })

  it('clears an existing binding', async () => {
    repo.bindings = [binding({ id: 'binding-7' })]
    await expect(revokeDocumentRole('proj-1', 'binding-7', session)).resolves.toBeUndefined()
    expect(repo.deleted).toEqual(['binding-7'])
  })
})
