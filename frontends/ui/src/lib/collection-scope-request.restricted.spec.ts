/**
 * @vitest-environment node
 */
/**
 * ADR-0078 — a restricted folder's collection enters the signed scope only for
 * a session cleared for it, only in an interactive chat turn, and only on a
 * conversation nobody else can read.
 *
 * The folder-access decision runs for real over a mocked folder tree, so the
 * only thing that differs between the cleared and the uncleared member below is
 * their session: clearance is computed from the session and nothing else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationTenancy: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectCollectionName: vi.fn() }))
vi.mock('@/lib/user-preferences/repository', () => ({ findUserPreferencesForSession: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/repository', () => ({ countGrantsForResource: vi.fn() }))
vi.mock('@/lib/authz/folder-access-repository', () => ({
  projectHasRestrictedFolders: vi.fn(),
  listProjectFolderTree: vi.fn(),
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import { restrictedCollectionName, type AccessFolder } from '@/lib/authz/folder-access'
import { listProjectFolderTree, projectHasRestrictedFolders } from '@/lib/authz/folder-access-repository'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { findProjectCollectionName } from '@/lib/projects/repository'
import { parseBodyContext, parseQueryContext } from '@/lib/proxy/collection-authz'
import { countGrantsForResource } from '@/lib/sharing/repository'
import { findUserPreferencesForSession } from '@/lib/user-preferences/repository'
import { buildCollectionScopeFromRequest } from './collection-scope-request'

const ORG_ID = 'org_1'
const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const PROJECT_COLLECTION = 'proj_8f2c3b1e_0000_4000_8000_000000000001'
const CONVERSATION_ID = 's_7d1e2c3b_0000_4000_8000_00000000000c'
const FOLDER = {
  vertraege: '22222222-aaaa-4bbb-8ccc-000000000002',
  plaene: '44444444-aaaa-4bbb-8ccc-000000000004',
}
const RESTRICTED = restrictedCollectionName(PROJECT_COLLECTION, FOLDER.vertraege)

const TREE: AccessFolder[] = [
  { id: FOLDER.vertraege, parentId: null, restrictedRoles: ['org-geschaeftsfuehrung'] },
  { id: FOLDER.plaene, parentId: null, restrictedRoles: null },
]

function sessionWith(roles: string[], permissions: string[] = []): AuthorizedSession {
  return {
    userId: 'user_me',
    organizationId: ORG_ID,
    email: 'me@grid.test',
    role: roles[0],
    roles,
    permissions,
    featureFlags: null,
  } as unknown as AuthorizedSession
}

const director = sessionWith(['org-geschaeftsfuehrung'])
const intern = sessionWith(['member'])
const orgAdmin = sessionWith(['admin'], ['org:projects:administer'])

const chatTurn = { projectId: PROJECT_ID, conversationId: CONVERSATION_ID, interactiveChat: true }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.REQUIRE_AUTH = 'true'
  process.env.BASE_COLLECTION_NAME = 'oib_knowledge'
  vi.mocked(findProjectCollectionName).mockResolvedValue(PROJECT_COLLECTION)
  vi.mocked(findUserPreferencesForSession).mockResolvedValue(null)
  // A conversation that does not exist yet: the first message creates it private.
  vi.mocked(findConversationTenancy).mockResolvedValue(null)
  vi.mocked(countGrantsForResource).mockResolvedValue(0)
  vi.mocked(projectHasRestrictedFolders).mockResolvedValue(true)
  vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
})

describe('interactive chat scope (ADR-0078)', () => {
  it("carries a cleared member's restricted collection, on the project shelf, after the project collection", async () => {
    const { scope, scopedCollections } = await buildCollectionScopeFromRequest(director, chatTurn)

    expect(scope.indexOf(RESTRICTED)).toBe(scope.indexOf(PROJECT_COLLECTION) + 1)
    expect(scopedCollections).toContainEqual({ collection: RESTRICTED, shelf: 'project' })
  })

  it('carries it for an organization admin, who sees everything', async () => {
    const { scope } = await buildCollectionScopeFromRequest(orgAdmin, chatTurn)

    expect(scope).toContain(RESTRICTED)
  })

  it("never carries it for a member who is not cleared — the project's own collection stays", async () => {
    const { scope } = await buildCollectionScopeFromRequest(intern, chatTurn)

    expect(scope).toContain(PROJECT_COLLECTION)
    expect(scope).not.toContain(RESTRICTED)
  })

  it('carries none, and asks nothing more, in a project that restricts nothing', async () => {
    vi.mocked(projectHasRestrictedFolders).mockResolvedValue(false)

    const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

    expect(scope.filter((name) => name.startsWith(`${PROJECT_COLLECTION}_r`))).toEqual([])
    expect(listProjectFolderTree).not.toHaveBeenCalled()
    expect(countGrantsForResource).not.toHaveBeenCalled()
  })

  it('carries none on a socket that names no conversation', async () => {
    const { scope } = await buildCollectionScopeFromRequest(director, {
      projectId: PROJECT_ID,
      interactiveChat: true,
    })

    expect(scope).not.toContain(RESTRICTED)
  })

  describe('only on a conversation nobody else can read', () => {
    const tenancy = {
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      visibility: 'private' as const,
      createdBy: 'user_me',
      deletedAt: null,
    }

    it("carries it on the member's own private, ungranted conversation", async () => {
      vi.mocked(findConversationTenancy).mockResolvedValue(tenancy)

      const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

      expect(scope).toContain(RESTRICTED)
      expect(countGrantsForResource).toHaveBeenCalledWith('conversation', CONVERSATION_ID)
    })

    it('carries none on a conversation shared with the project', async () => {
      vi.mocked(findConversationTenancy).mockResolvedValue({ ...tenancy, visibility: 'project' })

      const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

      expect(scope).not.toContain(RESTRICTED)
    })

    it('carries none on a private conversation that grants anyone access', async () => {
      vi.mocked(findConversationTenancy).mockResolvedValue(tenancy)
      vi.mocked(countGrantsForResource).mockResolvedValue(1)

      const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

      expect(scope).not.toContain(RESTRICTED)
    })

    it("carries none on somebody else's conversation the member was let into", async () => {
      vi.mocked(findConversationTenancy).mockResolvedValue({ ...tenancy, createdBy: 'user_colleague' })

      const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

      expect(scope).not.toContain(RESTRICTED)
    })
  })
})

describe('every other scope carries no restricted collection, whoever asks (ADR-0078)', () => {
  it('deep research: the submit body cannot ask for an interactive scope', async () => {
    // Exactly what `POST /api/jobs/async/submit` hands the builder. A smuggled
    // flag is not one of the fields the body parser reads.
    const context = parseBodyContext({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      interactiveChat: true,
    })

    for (const session of [director, orgAdmin]) {
      const { scope } = await buildCollectionScopeFromRequest(session, context)
      expect(scope).toContain(PROJECT_COLLECTION)
      expect(scope).not.toContain(RESTRICTED)
    }
  })

  it('deep research status, stream and cancel, and the v1 proxy: query context', async () => {
    const context = parseQueryContext(
      new URLSearchParams({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, interactiveChat: 'true' })
    )

    const { scope } = await buildCollectionScopeFromRequest(orgAdmin, context)

    expect(scope).not.toContain(RESTRICTED)
  })

  it('never reads the folder tree for a scope that is not an interactive chat turn', async () => {
    await buildCollectionScopeFromRequest(director, { projectId: PROJECT_ID, conversationId: CONVERSATION_ID })

    expect(projectHasRestrictedFolders).not.toHaveBeenCalled()
  })

  it('an anonymous deployment: no session, no clearance', async () => {
    process.env.REQUIRE_AUTH = 'false'

    const { scope } = await buildCollectionScopeFromRequest(null, chatTurn)

    expect(scope).not.toContain(RESTRICTED)
  })
})
