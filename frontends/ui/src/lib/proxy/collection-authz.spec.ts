/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// `@/lib/backend-proxy` statically imports the session guard, which pulls in
// authkit; the collection-authz decision logic never calls it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import {
  normalizeSessionCollectionName,
  parseBodyContext,
  parseQueryContext,
  resolveRequestContext,
  validateCollectionName,
  type CollectionAuthzDeps,
} from './collection-authz'

const session = { organizationId: 'org-1', userId: 'user-1' } as unknown as GridSession

const deps = (overrides: Partial<CollectionAuthzDeps> = {}): CollectionAuthzDeps => ({
  findProjectIdByCollection: vi.fn().mockResolvedValue('proj-id-1'),
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-editor' }),
  ...overrides,
})

const errorBody = async (response: Response) => (await response.json()) as { error: { code: string } }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('validateCollectionName', () => {
  it('passes through paths that are not collection-scoped', async () => {
    expect(await validateCollectionName(['documents'], session, {}, deps())).toBeNull()
    expect(await validateCollectionName(['collections'], session, {}, deps())).toBeNull()
  })

  it('rejects uploads to the base corpus (400 INVALID_COLLECTION)', async () => {
    vi.stubEnv('BASE_COLLECTION_NAME', 'base_corpus')
    const response = await validateCollectionName(['collections', 'base_corpus'], session, {}, deps())
    expect(response?.status).toBe(400)
    expect((await errorBody(response as Response)).error.code).toBe('INVALID_COLLECTION')
  })

  it('rejects the default base corpus name when the env var is unset', async () => {
    const response = await validateCollectionName(['collections', 'oib_knowledge'], session, {}, deps())
    expect(response?.status).toBe(400)
  })

  it('rejects proj_* collections without an org session (403)', async () => {
    const d = deps()
    const response = await validateCollectionName(['collections', 'proj_abc'], null, {}, d)
    expect(response?.status).toBe(403)
    expect(d.findProjectIdByCollection).not.toHaveBeenCalled()
  })

  it('rejects proj_* collections not found in the caller org (404)', async () => {
    const d = deps({ findProjectIdByCollection: vi.fn().mockResolvedValue(null) })
    const response = await validateCollectionName(['collections', 'proj_abc'], session, {}, d)
    expect(response?.status).toBe(404)
    expect(d.findProjectIdByCollection).toHaveBeenCalledWith('proj_abc', 'org-1')
    expect(d.requireProjectAccess).not.toHaveBeenCalled()
  })

  it('requires project:edit on the owning project and allows when granted', async () => {
    const d = deps()
    const response = await validateCollectionName(['collections', 'proj_abc'], session, {}, d)
    expect(response).toBeNull()
    expect(d.requireProjectAccess).toHaveBeenCalledWith(
      session as AuthorizedSession,
      'proj-id-1',
      'project:edit',
    )
  })

  it('maps a project access denial to 404 (no existence leak)', async () => {
    const d = deps({ requireProjectAccess: vi.fn().mockRejectedValue(new NotFoundError()) })
    const response = await validateCollectionName(['collections', 'proj_abc'], session, {}, d)
    expect(response?.status).toBe(404)
  })

  it('accepts s_* collections that match the active conversation', async () => {
    expect(
      await validateCollectionName(['collections', 's_conv-1'], session, { conversationId: 'conv-1' }, deps()),
    ).toBeNull()
    expect(
      await validateCollectionName(['collections', 's_conv-1'], session, { conversationId: 's_conv-1' }, deps()),
    ).toBeNull()
  })

  it('rejects s_* collections that do not match the conversation (400)', async () => {
    const mismatched = await validateCollectionName(
      ['collections', 's_conv-1'],
      session,
      { conversationId: 'conv-2' },
      deps(),
    )
    expect(mismatched?.status).toBe(400)

    const missing = await validateCollectionName(['collections', 's_conv-1'], session, {}, deps())
    expect(missing?.status).toBe(400)
  })

  it('rejects any other collection name (400)', async () => {
    const response = await validateCollectionName(['collections', 'random'], session, {}, deps())
    expect(response?.status).toBe(400)
    expect((await errorBody(response as Response)).error.code).toBe('INVALID_COLLECTION')
  })

  // The org-wide Archiv collection (ADR-0024): must be THIS org's Archiv AND the
  // caller must hold org:archiv:manage (proxy routes cover writes).
  const archivManager = {
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'member',
    permissions: ['org:archiv:manage'],
  } as unknown as GridSession
  const archivMember = {
    organizationId: 'org-1',
    userId: 'user-2',
    role: 'member',
    permissions: [],
  } as unknown as GridSession

  it('accepts the caller-org Archiv collection for a manager', async () => {
    expect(await validateCollectionName(['collections', 'archiv_org-1'], archivManager, {}, deps())).toBeNull()
  })

  it('rejects the Archiv collection for a member without manage (403)', async () => {
    const response = await validateCollectionName(['collections', 'archiv_org-1'], archivMember, {}, deps())
    expect(response?.status).toBe(403)
  })

  it("rejects another org's Archiv collection (403)", async () => {
    const response = await validateCollectionName(['collections', 'archiv_org-2'], archivManager, {}, deps())
    expect(response?.status).toBe(403)
  })

  it('rejects the Archiv collection without an org session (403)', async () => {
    const response = await validateCollectionName(['collections', 'archiv_org-1'], null, {}, deps())
    expect(response?.status).toBe(403)
  })
})

describe('request context extraction', () => {
  it('normalizes session collection names', () => {
    expect(normalizeSessionCollectionName('conv-1')).toBe('s_conv-1')
    expect(normalizeSessionCollectionName('s_conv-1')).toBe('s_conv-1')
  })

  it('parses query context, treating empty values as absent', () => {
    expect(parseQueryContext(new URLSearchParams('projectId=p1&conversationId='))).toEqual({
      projectId: 'p1',
      conversationId: undefined,
    })
  })

  it('parses body context, honoring the session_id alias', () => {
    expect(parseBodyContext({ projectId: 'p1', session_id: 'conv-1' })).toEqual({
      projectId: 'p1',
      conversationId: 'conv-1',
    })
    expect(parseBodyContext({ projectId: 42, conversationId: 'conv-1', session_id: 'ignored' })).toEqual({
      projectId: undefined,
      conversationId: 'conv-1',
    })
    expect(parseBodyContext(undefined)).toEqual({ projectId: undefined, conversationId: undefined })
  })

  it('resolves request context with body fields winning over query params', () => {
    const searchParams = new URLSearchParams('projectId=query-p&conversationId=query-c')
    expect(resolveRequestContext(searchParams, { projectId: 'body-p' })).toEqual({
      projectId: 'body-p',
      conversationId: 'query-c',
    })
    expect(resolveRequestContext(searchParams)).toEqual({
      projectId: 'query-p',
      conversationId: 'query-c',
    })
  })
})
