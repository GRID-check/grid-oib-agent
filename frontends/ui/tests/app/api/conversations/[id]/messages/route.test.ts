/**
 * `GET /api/conversations/[id]/messages` — listing a thread's history.
 *
 * **Rewritten for the collaboration authorization model (ADR-0032)**, for the
 * same reason as the sibling `[id]/route.test.ts`: this file used to fake drizzle
 * by call ORDER (first `select()` = the conversation probe, second = the
 * messages), which broke the moment access resolution added queries of its own.
 * Mocking the repository boundary instead makes it robust against the next such
 * change, and tests the contract rather than the query builder.
 *
 * Reading a thread requires `viewer` — the weakest role — so both cases here are
 * about the route, with one addition worth keeping honest: legacy messages with
 * no recorded author are attributed to the conversation's creator **at read
 * time** (spec CC-3, MG-3), so the response is the right place to prove it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
  authzErrorResponse: () => null,
}))

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))

vi.mock('@/lib/sharing/repository', () => ({
  findGrantForSubject: vi.fn(),
  countGrantsForResource: vi.fn(),
}))

vi.mock('@/lib/conversations/repository', () => ({
  deleteConversationInOrg: vi.fn(),
  findConversationInOrg: vi.fn(),
  findConversationRead: vi.fn(),
  findConversationTenancy: vi.fn(),
  findMessageInConversation: vi.fn(),
  insertConversation: vi.fn(),
  insertMessages: vi.fn(),
  listMessagesForConversation: vi.fn(),
  listVisibleConversations: vi.fn(),
  mergeMessageMetadata: vi.fn(),
  updateConversationMetaInOrg: vi.fn(),
  updateConversationTitleInOrg: vi.fn(),
  upsertConversationRead: vi.fn(),
}))

import { GET } from '@/app/api/conversations/[id]/messages/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationTenancy, listMessagesForConversation } from '@/lib/conversations/repository'
import { findGrantForSubject } from '@/lib/sharing/repository'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

const session = {
  userId: 'user_1',
  email: 'a@b.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member' as const,
  permissions: [] as string[],
  featureFlags: null,
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

describe('/api/conversations/[id]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' } as never)
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'private',
      createdBy: 'user_1',
      deletedAt: null,
    })
    vi.mocked(findGrantForSubject).mockResolvedValue(null)
  })

  it('lists messages for a conversation', async () => {
    vi.mocked(listMessagesForConversation).mockResolvedValue([
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        conversationId: 's_conv_1',
        role: 'user',
        // Written before authorship existed — attribution happens on read.
        authorUserId: null,
        content: 'hello',
        metadata: null,
        createdAt: new Date(),
      },
      {
        id: '550e8400-e29b-41d4-a716-446655440001',
        conversationId: 's_conv_1',
        role: 'assistant',
        authorUserId: null,
        content: 'hi there',
        metadata: null,
        createdAt: new Date(),
      },
    ])

    const res = await GET(
      new Request('http://localhost:3000/api/conversations/s_conv_1/messages'),
      makeParams('s_conv_1'),
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toHaveLength(2)
    expect(json[0].role).toBe('user')
    // The legacy human message is attributed to the creator; the assistant row
    // keeps its null author, because that is correct rather than missing.
    expect(json[0].authorUserId).toBe('user_1')
    expect(json[1].authorUserId).toBeNull()
  })

  it('returns 404 when conversation does not exist', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue(null)

    const res = await GET(
      new Request('http://localhost:3000/api/conversations/nonexistent/messages'),
      makeParams('nonexistent'),
    )

    expect(res.status).toBe(404)
    // Access is refused before the history query is even attempted.
    expect(listMessagesForConversation).not.toHaveBeenCalled()
  })
})
