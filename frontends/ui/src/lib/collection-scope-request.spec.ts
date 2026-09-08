/**
 * @vitest-environment node
 */
/**
 * The WebSocket upgrade's scope resolution authorizes BOTH caller-supplied
 * identifiers (ADR-0032, spec SH-4/SH-6).
 *
 * `projectId` was always checked; `conversationId` was not. That mattered because
 * the finished agent turn is persisted through the internal service path, whose
 * only tenancy gate is an org-scoped conversation lookup — so an unauthorized
 * `conversationId` on the upgrade meant a signed-in colleague could open a turn on
 * somebody's private thread and have the answer written into it and fanned out to
 * its real participants.
 *
 * The subtlety worth a test of its own: conversation ids are client-generated and
 * the row appears with the first message, so an id that does not exist yet MUST
 * still be allowed. Absent is fine; existing-but-unreachable is not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationTenancy: vi.fn() }))
vi.mock('@/lib/sharing/repository', () => ({ findGrantForSubject: vi.fn() }))
// Mocked rather than driven through the db stub so the workspace specs below can
// assert the STRONG claim: the office turn never reads the preference at all.
vi.mock('@/lib/user-preferences/repository', () => ({ findUserPreferencesForSession: vi.fn() }))
// The mounts the office turn reads are stubbed at the REPOSITORY, one layer
// below the service, so `listAuthorizedMounts` — the re-authorization that is
// the whole point of MT-7 — runs for real against the `requireProjectAccess`
// mock above. Stubbing the service instead would leave the drop path asserting
// nothing but the stub.
vi.mock('@/lib/workspace/mounts-repository', () => ({
  listConversationMounts: vi.fn(),
  insertConversationMount: vi.fn(),
  deleteConversationMount: vi.fn(),
}))
// Reached only from the service's WRITE path, which this file never takes;
// mocked so the office specs do not drag a WorkOS client and the conversation
// service into a scope-building test.
vi.mock('@/lib/conversations/service', () => ({ createConversation: vi.fn() }))
vi.mock('@/lib/authz/membership-role', () => ({ resolveMembershipRole: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import { isAuthzError } from '@/lib/auth-utils'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { getDb } from '@/lib/db'
import { findGrantForSubject } from '@/lib/sharing/repository'
import { findUserPreferencesForSession } from '@/lib/user-preferences/repository'
import { listConversationMounts, type MountRow } from '@/lib/workspace/mounts-repository'
import { buildCollectionScopeFromRequest } from './collection-scope-request'

const CONVERSATION_ID = 'conv_private_of_a_colleague'
const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

/** `resolveActiveProjectId` reads user preferences; no project is stored. */
function stubDb(): void {
  const limit = vi.fn().mockResolvedValue([])
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.REQUIRE_AUTH = 'true'
  stubDb()
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' } as never)
  vi.mocked(findGrantForSubject).mockResolvedValue(null)
  vi.mocked(findUserPreferencesForSession).mockResolvedValue(null)
  vi.mocked(listConversationMounts).mockResolvedValue([])
})

describe('a conversationId on the WS upgrade is authorized (F2)', () => {
  it('refuses an existing conversation the caller cannot reach, and the refusal reads as an authz error', async () => {
    // Somebody else's private thread, in a project this caller CAN see: only the
    // conversation-level check can catch this one.
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'private',
      createdBy: 'user_colleague',
      deletedAt: null,
    })

    const failure = await buildCollectionScopeFromRequest(session, {
      conversationId: CONVERSATION_ID,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(NotFoundError)
    // The websocket-scope route answers 403 on exactly this classification, and
    // the gateway destroys the socket on a non-2xx — so the upgrade is refused.
    expect(isAuthzError(failure)).toBe(true)
  })

  it('refuses a conversation in another organization', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_2',
      projectId: null,
      visibility: 'project',
      createdBy: 'user_me',
      deletedAt: null,
    })

    await expect(
      buildCollectionScopeFromRequest(session, { conversationId: CONVERSATION_ID }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('ALLOWS a brand-new client-generated id that does not exist yet — the first-message path', async () => {
    // The row is created by the first message POST, so the upgrade legitimately
    // names an id the database has never seen. Refusing this would break every
    // new chat.
    vi.mocked(findConversationTenancy).mockResolvedValue(null)

    const result = await buildCollectionScopeFromRequest(session, {
      conversationId: 'conv_brand_new',
    })

    expect(result.conversationId).toBe('conv_brand_new')
    expect(result.scope).toContain('s_conv_brand_new')
  })

  it('allows a conversation the caller created', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'private',
      createdBy: session.userId,
      deletedAt: null,
    })

    const result = await buildCollectionScopeFromRequest(session, {
      conversationId: CONVERSATION_ID,
      projectId: PROJECT_ID,
    })

    expect(result.conversationId).toBe(CONVERSATION_ID)
  })

  it('allows a thread shared with the caller by an explicit grant', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'private',
      createdBy: 'user_colleague',
      deletedAt: null,
    })
    vi.mocked(findGrantForSubject).mockResolvedValue({ role: 'collaborator' } as never)

    const result = await buildCollectionScopeFromRequest(session, {
      conversationId: CONVERSATION_ID,
    })

    expect(result.conversationId).toBe(CONVERSATION_ID)
  })

  it('never probes a conversation when the request carries no conversation id', async () => {
    await buildCollectionScopeFromRequest(session, { projectId: PROJECT_ID })

    expect(findConversationTenancy).not.toHaveBeenCalled()
  })
})

/**
 * ADR-0054 / spec KH-5, MG-3 — the Büro turn has no project, and must not
 * acquire one.
 *
 * The removal is deliberate and total, which is why these specs assert on the
 * *calls* and not only on the resulting scope: an office turn that happened to
 * produce no `proj_` entry because the stale preference pointed at a project the
 * caller can no longer read would still have paid for the FGA round-trip and
 * would still be one membership change away from silently widening retrieval.
 * The mode is what removes it, so nothing is asked in the first place.
 */
describe('scope: workspace never inherits an active project (KH-5)', () => {
  const STALE_PROJECT_ID = 'e2f0a1b2-0000-4000-8000-000000000001'

  beforeEach(() => {
    // Flag enforcement off is the shipped default and the fail-open path the
    // Archiv injection below rides (spec WS-15).
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
    vi.mocked(findConversationTenancy).mockResolvedValue(null)
    vi.mocked(findUserPreferencesForSession).mockResolvedValue({
      active_project_id: STALE_PROJECT_ID,
    })
  })

  it('yields no proj_ entry, reads no preference and checks no project access', async () => {
    const result = await buildCollectionScopeFromRequest(session, {
      scope: 'workspace',
      conversationId: CONVERSATION_ID,
    })

    expect(result.projectId).toBeUndefined()
    expect(result.projectCollectionName).toBeUndefined()
    expect(result.scope.some((collection) => collection.startsWith('proj_'))).toBe(false)
    expect(findUserPreferencesForSession).not.toHaveBeenCalled()
    expect(requireProjectAccess).not.toHaveBeenCalled()
  })

  it('drops a projectId handed to it alongside the workspace scope', async () => {
    const result = await buildCollectionScopeFromRequest(session, {
      scope: 'workspace',
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
    })

    expect(result.projectId).toBeUndefined()
    expect(result.scope).not.toContain(`proj_${PROJECT_ID}`)
    expect(requireProjectAccess).not.toHaveBeenCalled()
  })

  it('still carries the base corpus, the org Archiv and the conversation shelf', async () => {
    const { scope } = await buildCollectionScopeFromRequest(session, {
      scope: 'workspace',
      conversationId: CONVERSATION_ID,
    })

    expect(scope).toEqual([
      'oib_knowledge',
      `archiv_${session.organizationId}`,
      `s_${CONVERSATION_ID}`,
    ])
  })

  it('leaves project mode alone: the stale preference is still the fallback there', async () => {
    // The counterweight to the three specs above. KH-5 removes the fallback for
    // the office surface ONLY; a project request that names no project keeps the
    // behaviour it has today, degrade included.
    const { scope, projectId } = await buildCollectionScopeFromRequest(session, {
      conversationId: CONVERSATION_ID,
    })

    expect(projectId).toBe(STALE_PROJECT_ID)
    expect(scope).toContain(`proj_${STALE_PROJECT_ID}`)
    expect(findUserPreferencesForSession).toHaveBeenCalledWith(
      session.userId,
      session.organizationId
    )
  })
})

/**
 * ADR-0054 / spec MT-7, KH-13 — the persisted mounts join the office turn's
 * scope, re-authorized, carrying the project they belong to.
 *
 * Three claims, and the third is the one nothing else would catch. A mount adds
 * a collection AND two strings to the scope header, and that header rides the
 * WebSocket upgrade: a per-mount cost that looks free at one project is a header
 * nobody can send at five. The bound is asserted at the cap, with names at the
 * length the product actually allows.
 */
describe('scope: workspace carries the conversation’s mounted projects (MT-7)', () => {
  /** 80 characters — the longest project name the product accepts. */
  const longName = (index: number) => `Projekt ${index} `.padEnd(80, 'ä').slice(0, 80)

  const mountRow = (index: number): MountRow => ({
    projectId: `0000000${index}-0000-4000-8000-00000000000${index}`,
    projectName: longName(index),
    collectionName: `proj_0000000${index}-0000-4000-8000-00000000000${index}`,
    mountedBy: 'user',
    mountedByUserId: 'user_me',
    mountedAt: new Date('2026-09-08T10:00:00.000Z'),
  })

  const fiveMounts = Array.from({ length: 5 }, (_unused, index) => mountRow(index))

  beforeEach(() => {
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
    vi.mocked(findConversationTenancy).mockResolvedValue(null)
  })

  it('turns five mounts into five project entries, each naming its project', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue(fiveMounts)

    const { scope, scopedCollections } = await buildCollectionScopeFromRequest(session, {
      scope: 'workspace',
      conversationId: CONVERSATION_ID,
    })

    // Position is the hierarchy's: base → Archiv → the mounted projects → this
    // conversation's own shelf.
    expect(scope).toEqual([
      'oib_knowledge',
      `archiv_${session.organizationId}`,
      ...fiveMounts.map((mount) => mount.collectionName),
      `s_${CONVERSATION_ID}`,
    ])

    const projects = scopedCollections.filter((entry) => entry.shelf === 'project')
    expect(projects).toHaveLength(5)
    expect(projects).toEqual(
      fiveMounts.map((mount) => ({
        collection: mount.collectionName,
        shelf: 'project',
        projectId: mount.projectId,
        projectName: mount.projectName,
      }))
    )
    // Every mount was re-authorized on THIS upgrade, with the chat permission —
    // not the view permission, and not once for the set.
    expect(requireProjectAccess).toHaveBeenCalledTimes(5)
    expect(requireProjectAccess).toHaveBeenCalledWith(
      session,
      fiveMounts[0].projectId,
      expect.arrayContaining(['project:chat'])
    )
  })

  it('drops a mount whose re-authorization fails and keeps the rest of the turn', async () => {
    // The revocation path: `project:chat` was taken away between two turns. The
    // scope narrows at this upgrade — it does not fail, because the alternative
    // to a narrower answer would be no answer at all.
    vi.mocked(listConversationMounts).mockResolvedValue(fiveMounts)
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, projectId) =>
      projectId === fiveMounts[2].projectId
        ? Promise.reject(new NotFoundError())
        : ({ role: 'project-editor' } as never)
    )

    const { scope, scopedCollections } = await buildCollectionScopeFromRequest(session, {
      scope: 'workspace',
      conversationId: CONVERSATION_ID,
    })

    expect(scope).not.toContain(fiveMounts[2].collectionName)
    expect(scope).toContain(fiveMounts[3].collectionName)
    expect(scopedCollections.filter((entry) => entry.shelf === 'project')).toHaveLength(4)
  })

  it('keeps the scope header under 8 KB at the cap with the longest names', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue(fiveMounts)

    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      scope: 'workspace',
      conversationId: CONVERSATION_ID,
    })

    // The header rides the WebSocket upgrade as a request header, where 8 KB is
    // the ceiling every proxy in the path agrees on. Measured in BYTES, because
    // a project name is German and `ä` is two of them.
    expect(Buffer.byteLength(headerValue, 'utf8')).toBeLessThan(8 * 1024)
  })

  it('asks for no mounts at all in a project chat', async () => {
    // A project conversation has its one locked project; asking would be a query
    // per turn whose answer is always empty.
    vi.mocked(listConversationMounts).mockResolvedValue(fiveMounts)

    const { scope } = await buildCollectionScopeFromRequest(session, {
      conversationId: CONVERSATION_ID,
      projectId: PROJECT_ID,
    })

    expect(listConversationMounts).not.toHaveBeenCalled()
    expect(scope.filter((collection) => collection.startsWith('proj_'))).toEqual([
      `proj_${PROJECT_ID}`,
    ])
  })
})
