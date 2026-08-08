/**
 * @vitest-environment node
 */
/**
 * The card-decision PATCH is the server half of interactive-card persistence
 * (see features/grid-cards/card-decision.ts). Two things must hold: the caller is
 * authorized as a `collaborator` on the conversation before the message row is
 * touched — answering a card is contributing, and `messages` has no organization
 * column of its own — and only decisions from the closed union can be written,
 * because the stored blob is replayed straight into the renderer on rehydrate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    role: 'member',
    permissions: [],
  }),
  authzErrorResponse: () => null,
}))

const findConversationTenancy = vi.fn()
const mergeMessageMetadata = vi.fn()

vi.mock('@/lib/conversations/repository', () => ({
  findConversationTenancy: (...args: unknown[]) => findConversationTenancy(...args),
  mergeMessageMetadata: (...args: unknown[]) => mergeMessageMetadata(...args),
  findConversationInOrg: vi.fn(),
  findConversationRead: vi.fn(),
  findMessageInConversation: vi.fn(),
  insertConversation: vi.fn(),
  insertMessages: vi.fn(),
  listVisibleConversations: vi.fn(),
  listMessagesForConversation: vi.fn(),
  deleteConversationInOrg: vi.fn(),
  updateConversationMetaInOrg: vi.fn(),
  updateConversationTitleInOrg: vi.fn(),
  upsertConversationRead: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/sharing/repository', () => ({
  findGrantForSubject: vi.fn(),
  countGrantsForResource: vi.fn(),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { findGrantForSubject } from '@/lib/sharing/repository'
import { PATCH } from './route'

const MESSAGE_ID = '4f1a2b3c-1111-4222-8333-444455556666'
const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const URL = `https://grid.example/api/conversations/conv_1/messages/${MESSAGE_ID}`

const patch = (body: unknown, messageId = MESSAGE_ID) =>
  PATCH(new Request(URL, { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'conv_1', messageId }),
  })

const decisions = {
  'memory_proposal-0': { decision: 'savedOrg', decidedAt: '2026-07-28T09:00:00.000Z' },
}

describe('PATCH /api/conversations/[id]/messages/[messageId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findConversationTenancy.mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'project',
      createdBy: 'user_1',
      deletedAt: null,
    })
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' } as never)
    vi.mocked(findGrantForSubject).mockResolvedValue(null)
    mergeMessageMetadata.mockResolvedValue({
      id: MESSAGE_ID,
      metadata: { cardInteractions: decisions },
    })
  })

  it('merges the decisions into the message metadata, per card key', async () => {
    const res = await patch({ cardInteractions: decisions })

    expect(res.status).toBe(200)
    // The fourth argument is what stops a second client's PATCH from erasing a
    // decision it never saw — without it the whole map is replaced.
    expect(mergeMessageMetadata).toHaveBeenCalledWith(
      'conv_1',
      MESSAGE_ID,
      { cardInteractions: decisions },
      ['cardInteractions']
    )
  })

  it('authorizes the conversation before touching the message row', async () => {
    await patch({ cardInteractions: decisions })
    // Regression guard: `messages` has no organization column, so without an
    // access check on the conversation any signed-in user could patch another
    // tenant's message by id — and after ADR-0032, any COLLEAGUE could patch a
    // message in a thread they merely happen to know the id of.
    expect(findConversationTenancy).toHaveBeenCalledWith('conv_1')
    expect(requireProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      PROJECT_ID,
      'project:view'
    )
  })

  it('404s for a conversation outside the caller organization', async () => {
    findConversationTenancy.mockResolvedValue({
      organizationId: 'org_2',
      projectId: PROJECT_ID,
      visibility: 'project',
      createdBy: 'user_1',
      deletedAt: null,
    })
    const res = await patch({ cardInteractions: decisions })
    expect(res.status).toBe(404)
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
  })

  it("404s a card decision in someone else's private thread", async () => {
    findConversationTenancy.mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'private',
      createdBy: 'user_2',
      deletedAt: null,
    })
    const res = await patch({ cardInteractions: decisions })
    expect(res.status).toBe(404)
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
  })

  it('404s a viewer who may read the thread but not contribute to it', async () => {
    findConversationTenancy.mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'private',
      createdBy: 'user_2',
      deletedAt: null,
    })
    vi.mocked(findGrantForSubject).mockResolvedValue({ role: 'viewer' } as never)
    const res = await patch({ cardInteractions: decisions })
    expect(res.status).toBe(404)
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
  })

  it('404s when the message is not part of that conversation', async () => {
    mergeMessageMetadata.mockResolvedValue(null)
    const res = await patch({ cardInteractions: decisions })
    expect(res.status).toBe(404)
  })

  it('rejects a decision outside the closed union', async () => {
    const res = await patch({
      cardInteractions: { 'memory_proposal-0': { decision: 'pwned', decidedAt: 'now' } },
    })
    expect(res.status).toBe(400)
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
  })

  it('400s on a malformed message id instead of failing in SQL', async () => {
    const res = await patch({ cardInteractions: decisions }, 'not-a-uuid')
    expect(res.status).toBe(400)
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
  })

  it('rejects a non-timestamp decidedAt', async () => {
    const res = await patch({
      cardInteractions: { 'memory_proposal-0': { decision: 'savedOrg', decidedAt: 'whenever' } },
    })
    expect(res.status).toBe(400)
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
  })

  it('rejects an oversized interactions map', async () => {
    // The value lands in a jsonb column; `z.record` bounds key length, not count.
    const oversized = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [
        `memory_proposal-${i}`,
        { decision: 'dismissed', decidedAt: '2026-07-28T09:00:00.000Z' },
      ])
    )
    const res = await patch({ cardInteractions: oversized })
    expect(res.status).toBe(400)
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
  })
})
