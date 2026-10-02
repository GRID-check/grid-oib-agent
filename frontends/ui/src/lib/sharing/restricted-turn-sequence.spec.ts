/**
 * @vitest-environment node
 */
/**
 * The order of events that used to let restricted content into a shared thread
 * (ADR-0078), end to end through the real confinement route, the real
 * conversation descriptor and the real sharing service. Only the stores are
 * fakes: an in-memory thread, its grants, and its restricted-turn mark.
 *
 * The case: the owner asks a question on a socket whose scope holds a
 * restricted folder's collection, and shares the thread while the answer is
 * still streaming. Nothing is stored yet, so no source names the restricted
 * collection, and the answer may never cite one (the inventory block put the
 * folder's summaries into the prompt). The share must still be refused,
 * because the turn's admission marked the thread before the answer began.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn((_scope: unknown, run: () => Promise<unknown>) => run()),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/events/bus', () => ({ publishToUsers: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({
  canUserAccessProject: vi.fn().mockResolvedValue(true),
  isUserInOrganization: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/mentions/service', () => ({ voidRequestsForSubject: vi.fn().mockResolvedValue(0) }))
vi.mock('@/lib/inbox/service', () => ({ markItemsInertForSubject: vi.fn().mockResolvedValue(0) }))
vi.mock('@/lib/limits', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/limits')>()),
  consumeLimit: vi.fn(),
}))
vi.mock('./access', () => ({ requireResourceAccess: vi.fn(), resolveResourceAccess: vi.fn() }))
vi.mock('./directory', () => ({
  loadOrganizationDirectory: vi.fn().mockResolvedValue(new Map()),
  unknownPerson: (userId: string) => ({ userId, email: null, name: userId, profilePictureUrl: null }),
}))
vi.mock('@/lib/documents/repository', () => ({
  findDocumentTenancy: vi.fn(),
  updateDocumentVisibilityInOrg: vi.fn(),
  documentIdsExisting: vi.fn(),
  listDocumentIdsForProject: vi.fn(),
}))

/** The stores, in memory. */
const store = vi.hoisted(() => ({
  visibility: 'private' as 'private' | 'project',
  grants: new Set<string>(),
  marks: new Map<string, number>(),
}))
const markKey = (conversationId: string, organizationId: string) => `${organizationId}/${conversationId}`

vi.mock('@/lib/conversations/repository', () => ({
  findConversationTenancy: vi.fn(async () => ({
    organizationId: 'org_1',
    projectId: 'proj_1',
    visibility: store.visibility,
    createdBy: 'user_me',
    deletedAt: null,
  })),
  updateConversationVisibilityInOrg: vi.fn(async (_id: string, _org: string, visibility: 'private' | 'project') => {
    store.visibility = visibility
    return {}
  }),
  findConversationInOrg: vi.fn(),
  conversationIdsExisting: vi.fn(),
  listConversationIdsForProject: vi.fn(),
  // Nothing is stored yet: the answer is still streaming.
  listRestrictedAnswerCollections: vi.fn(async () => []),
  recordRestrictedTurn: vi.fn(async (conversationId: string, organizationId: string) => {
    const key = markKey(conversationId, organizationId)
    const count = (store.marks.get(key) ?? 0) + 1
    store.marks.set(key, count)
    return { created: count === 1 }
  }),
  withdrawFreshRestrictedTurn: vi.fn(async (conversationId: string, organizationId: string) => {
    const key = markKey(conversationId, organizationId)
    if (store.marks.get(key) === 1) store.marks.delete(key)
  }),
  hasRestrictedTurn: vi.fn(async (conversationId: string, organizationId: string) =>
    store.marks.has(markKey(conversationId, organizationId))
  ),
}))

vi.mock('./repository', () => ({
  countGrantsForResource: vi.fn(async () => store.grants.size),
  listGrantsForResource: vi.fn(async () => []),
  upsertGrant: vi.fn(async (values: { subjectUserId: string }) => {
    store.grants.add(values.subjectUserId)
    return {}
  }),
  deleteGrant: vi.fn(async (_org: string, _type: string, _id: string, subjectUserId: string) =>
    store.grants.delete(subjectUserId)
  ),
  SHARE_ROSTER_LIMIT: 200,
}))

import { ConflictError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { SHARE_LIMIT, consumeLimit } from '@/lib/limits'
import { allowedDecision } from '@/test-utils/limit-fixtures'
import { POST as askConfinement } from '@/app/api/internal/conversations/[id]/confinement/route'
import { requireResourceAccess } from './access'
import { grantResourceAccess, setResourceVisibility } from './service'

const TOKEN = 'a-real-secret-token'
const CONVERSATION_ID = 's_7d1e2c3b_0000_4000_8000_00000000000c'
const owner = { userId: 'user_me', organizationId: 'org_1', email: 'me@grid.test' } as unknown as AuthorizedSession

/** What `aiq_api.chat_socket` does before a turn whose signed scope holds a restricted collection. */
async function agentAdmitsTurn(): Promise<boolean> {
  const response = await askConfinement(
    new Request(`https://grid.test/api/internal/conversations/${CONVERSATION_ID}/confinement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-grid-internal-token': TOKEN },
      body: JSON.stringify({ organizationId: 'org_1', userId: 'user_me' }),
    }),
    { params: Promise.resolve({ id: CONVERSATION_ID }) }
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { confined: boolean }).confined
}

beforeEach(() => {
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
  store.visibility = 'private'
  store.grants.clear()
  store.marks.clear()
  vi.mocked(consumeLimit).mockResolvedValue(allowedDecision(SHARE_LIMIT))
  vi.mocked(requireResourceAccess).mockImplementation(async () => ({
    role: 'owner',
    reason: 'creator',
    visibility: store.visibility,
    container: { organizationId: 'org_1', projectId: 'proj_1' },
    canEscalate: false,
  }))
})

describe('a share attempted while the first restricted answer streams (ADR-0078)', () => {
  it('is refused: the turn was admitted, and marked, before the answer began', async () => {
    expect(await agentAdmitsTurn()).toBe(true)

    const grant = await grantResourceAccess(owner, 'conversation', CONVERSATION_ID, {
      subjectUserId: 'user_colleague',
      role: 'viewer',
    }).catch((caught: unknown) => caught)
    const widen = await setResourceVisibility(owner, 'conversation', CONVERSATION_ID, 'project').catch(
      (caught: unknown) => caught
    )

    expect(grant).toBeInstanceOf(ConflictError)
    expect((grant as ConflictError).details).toMatchObject({ reason: 'restricted-content' })
    expect(widen).toBeInstanceOf(ConflictError)
    expect(store.grants.size).toBe(0)
    expect(store.visibility).toBe('private')
  })

  it('stays refused on every later turn, which keeps the mark', async () => {
    await agentAdmitsTurn()
    expect(await agentAdmitsTurn()).toBe(true)

    await expect(setResourceVisibility(owner, 'conversation', CONVERSATION_ID, 'project')).rejects.toBeInstanceOf(
      ConflictError
    )
  })
})

describe('a thread shared before any restricted turn', () => {
  it('can be shared, and its next restricted turn is refused and leaves no mark behind', async () => {
    await grantResourceAccess(owner, 'conversation', CONVERSATION_ID, {
      subjectUserId: 'user_colleague',
      role: 'viewer',
    })
    expect(store.grants.has('user_colleague')).toBe(true)

    // An open socket signed before the share asks for its next turn.
    expect(await agentAdmitsTurn()).toBe(false)
    expect(store.marks.size).toBe(0)

    // So the owner can still add people to the thread no restricted turn ran in.
    await grantResourceAccess(owner, 'conversation', CONVERSATION_ID, { subjectUserId: 'user_third', role: 'viewer' })
    expect(store.grants.has('user_third')).toBe(true)
  })
})
