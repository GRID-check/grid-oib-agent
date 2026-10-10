/**
 * @vitest-environment node
 */
/**
 * ADR-0087, ADR-0088 — a restricted folder's collection enters the signed scope
 * only for a session that may READ it (a read-only member as much as a writer),
 * only in an interactive chat turn, and only as far as everyone the
 * conversation is shared with may read it too.
 *
 * The folder-access decision runs for real over a mocked folder tree, so the
 * only thing that differs between the members below is their roles.
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
  projectHasCustomOrBinnedFolders: vi.fn(),
  listProjectFolderTree: vi.fn(),
}))
vi.mock('@/lib/conversations/restricted-use-repository', () => ({ readConversationAudience: vi.fn() }))
vi.mock('@/lib/auth/membership-roles', () => ({ resolveMembershipRoles: vi.fn() }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { restrictedCollectionName, type AccessFolder } from '@/lib/authz/folder-access'
import { resolveMembershipRoles } from '@/lib/auth/membership-roles'
import { listProjectFolderTree, projectHasCustomOrBinnedFolders } from '@/lib/authz/folder-access-repository'
import { readConversationAudience } from '@/lib/conversations/restricted-use-repository'
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
  {
    id: FOLDER.vertraege,
    parentId: null,
    accessMode: 'custom',
    grants: [
      { role: 'org-geschaeftsfuehrung', level: 'write' },
      { role: 'org-buchhaltung', level: 'read' },
    ],
  },
  { id: FOLDER.plaene, parentId: null, accessMode: 'inherit', grants: [] },
]

function sessionWith(roles: string[], permissions: string[] = [], userId = 'user_me'): AuthorizedSession {
  return {
    userId,
    organizationId: ORG_ID,
    email: 'me@grid.test',
    role: roles[0],
    roles,
    permissions,
    featureFlags: null,
  } as unknown as AuthorizedSession
}

const director = sessionWith(['org-geschaeftsfuehrung'])
/** May only read „Verträge“ — and reads it in chat exactly as a writer does. */
const accountant = sessionWith(['org-buchhaltung'])
const intern = sessionWith(['member'])
const orgAdmin = sessionWith(['admin'], ['org:projects:administer'], 'user_admin')

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
  vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(true)
  vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
  vi.mocked(readConversationAudience).mockResolvedValue({
    exists: false,
    projectId: null,
    createdBy: null,
    visibility: 'private',
    grantees: [],
  })
  vi.mocked(resolveMembershipRoles).mockImplementation(async (_org, userId) =>
    userId === 'user_admin' ? ['admin'] : userId === 'user_accountant' ? ['org-buchhaltung'] : userId === 'user_director' ? ['org-geschaeftsfuehrung'] : ['member']
  )
})

describe('interactive chat scope (ADR-0087)', () => {
  it("carries a cleared member's restricted collection, on the project shelf, after the project collection", async () => {
    const { scope, scopedCollections } = await buildCollectionScopeFromRequest(director, chatTurn)

    expect(scope.indexOf(RESTRICTED)).toBe(scope.indexOf(PROJECT_COLLECTION) + 1)
    expect(scopedCollections).toContainEqual({ collection: RESTRICTED, shelf: 'project' })
  })

  it('carries it for a member who may only READ the folder: retrieval keys on read, never on write', async () => {
    const { scope } = await buildCollectionScopeFromRequest(accountant, chatTurn)

    expect(scope).toContain(RESTRICTED)
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
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(false)

    const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

    expect(scope.filter((name) => name.startsWith(`${PROJECT_COLLECTION}_r`))).toEqual([])
    expect(listProjectFolderTree).not.toHaveBeenCalled()
    expect(readConversationAudience).not.toHaveBeenCalled()
  })

  it('carries none on a socket that names no conversation', async () => {
    const { scope } = await buildCollectionScopeFromRequest(director, {
      projectId: PROJECT_ID,
      interactiveChat: true,
    })

    expect(scope).not.toContain(RESTRICTED)
  })

  describe('narrowed to what everyone the conversation reaches may read (per person)', () => {
    const audience = (grantees: string[], visibility: 'private' | 'project' = 'private') => ({
      exists: true,
      projectId: PROJECT_ID,
      createdBy: 'user_me',
      visibility,
      grantees,
    })

    it("carries it on the member's own private, ungranted conversation", async () => {
      vi.mocked(readConversationAudience).mockResolvedValue(audience([]))

      const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

      expect(scope).toContain(RESTRICTED)
    })

    it('carries it on a conversation shared with a colleague who may read the folder, even read-only', async () => {
      vi.mocked(readConversationAudience).mockResolvedValue(audience(['user_accountant']))

      const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

      expect(scope).toContain(RESTRICTED)
    })

    it('carries none on a conversation shared with a colleague who may not read the folder', async () => {
      vi.mocked(readConversationAudience).mockResolvedValue(audience(['user_intern']))

      const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

      expect(scope).not.toContain(RESTRICTED)
    })

    it('carries none on a conversation shared with the project, whose readers cannot be enumerated', async () => {
      vi.mocked(readConversationAudience).mockResolvedValue(audience([], 'project'))

      const { scope } = await buildCollectionScopeFromRequest(director, chatTurn)

      expect(scope).not.toContain(RESTRICTED)
    })
  })
})

describe('every other scope carries no restricted collection, whoever asks (ADR-0087)', () => {
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

    expect(projectHasCustomOrBinnedFolders).not.toHaveBeenCalled()
  })

  it('an anonymous deployment: no session, no clearance', async () => {
    process.env.REQUIRE_AUTH = 'false'

    const { scope } = await buildCollectionScopeFromRequest(null, chatTurn)

    expect(scope).not.toContain(RESTRICTED)
  })
})
