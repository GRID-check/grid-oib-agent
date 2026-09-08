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

import { NotFoundError } from '@/lib/api/errors'
import { isAuthzError } from '@/lib/auth-utils'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { getDb } from '@/lib/db'
import { findGrantForSubject } from '@/lib/sharing/repository'
import { findUserPreferencesForSession } from '@/lib/user-preferences/repository'
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
