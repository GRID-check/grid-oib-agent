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

import { NotFoundError } from '@/lib/api/errors'
import { isAuthzError } from '@/lib/auth-utils'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { getDb } from '@/lib/db'
import { findGrantForSubject } from '@/lib/sharing/repository'
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
