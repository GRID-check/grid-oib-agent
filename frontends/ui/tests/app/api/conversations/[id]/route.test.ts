/**
 * `/api/conversations/[id]` — GET / PATCH happy paths and input validation.
 *
 * **Rewritten for the collaboration authorization model (ADR-0032).** These tests
 * used to fake drizzle by call ORDER: a `getDb` mock returning a different chain
 * object depending on how many times `select()` had been called. That only worked
 * while the number of queries per request stayed frozen, so adding the
 * access-resolution probes turned each of them into a 500. The brittleness was
 * the defect, not the new queries.
 *
 * They now mock at the **repository boundary**, like the newer specs beside them
 * (`src/app/api/conversations/[id]/route.spec.ts`). That is more robust and more
 * honest: what is under test is the route + service contract, not drizzle's
 * builder shape.
 *
 * DELETE's authorization (owner-only, and the no-op for an id that never reached
 * the server) is covered by that sibling spec, so this file keeps only its own
 * unique ground: the read/rename happy paths and the 400 on a missing title.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
  authzErrorResponse: () => null,
}))

// Container access granted, so the only interesting variable is the conversation.
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

import { GET, PATCH } from '@/app/api/conversations/[id]/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  findConversationInOrg,
  findConversationRead,
  findConversationTenancy,
  updateConversationTitleInOrg,
} from '@/lib/conversations/repository'
import { countGrantsForResource, findGrantForSubject } from '@/lib/sharing/repository'

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

const conversation = {
  id: 's_conv_1',
  organizationId: 'org_1',
  createdBy: 'user_1',
  title: 'Chat',
  tags: [] as string[],
  visibility: 'private' as const,
  engagement: null,
  projectId: PROJECT_ID,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

describe('/api/conversations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' } as never)
    // The caller created it, so they own it (ADR-0032). Every operation below is
    // permitted, which keeps these assertions about the route rather than the gate.
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'private',
      createdBy: 'user_1',
      deletedAt: null,
    })
    vi.mocked(findGrantForSubject).mockResolvedValue(null)
    vi.mocked(countGrantsForResource).mockResolvedValue(0)
    vi.mocked(findConversationRead).mockResolvedValue(null)
  })

  describe('GET', () => {
    it('returns the conversation when found', async () => {
      vi.mocked(findConversationInOrg).mockResolvedValue(conversation)

      const res = await GET(
        new Request('http://localhost:3000/api/conversations/s_conv_1'),
        makeParams('s_conv_1'),
      )

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.id).toBe('s_conv_1')
      // Access facts ride along so the client knows whether the server is
      // authoritative for this thread (ADR-0033).
      expect(json.myRole).toBe('owner')
      expect(json.visibility).toBe('private')
      expect(json.shared).toBe(false)
    })

    it('returns 404 when not found', async () => {
      // Nothing to resolve tenancy against. Denial and non-existence produce the
      // same response, so a caller cannot probe for other people's ids.
      vi.mocked(findConversationTenancy).mockResolvedValue(null)
      vi.mocked(findConversationInOrg).mockResolvedValue(null)

      const res = await GET(
        new Request('http://localhost:3000/api/conversations/nonexistent'),
        makeParams('nonexistent'),
      )

      expect(res.status).toBe(404)
    })
  })

  describe('PATCH', () => {
    it('updates the conversation title', async () => {
      vi.mocked(updateConversationTitleInOrg).mockResolvedValue({ ...conversation, title: 'Updated' })

      const res = await PATCH(
        new Request('http://localhost:3000/api/conversations/s_conv_1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Updated' }),
        }),
        makeParams('s_conv_1'),
      )

      expect(res.status).toBe(200)
      expect((await res.json()).title).toBe('Updated')
      // Tenancy still lives in the WHERE clause, not just in the gate above it.
      expect(updateConversationTitleInOrg).toHaveBeenCalledWith('s_conv_1', 'org_1', 'Updated')
    })

    it('returns 400 for missing title', async () => {
      const res = await PATCH(
        new Request('http://localhost:3000/api/conversations/s_conv_1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        makeParams('s_conv_1'),
      )

      expect(res.status).toBe(400)
      // Validation must reject before any write is attempted.
      expect(updateConversationTitleInOrg).not.toHaveBeenCalled()
    })
  })
})
