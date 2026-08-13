/**
 * @vitest-environment node
 */
/**
 * Deleting a conversation used to be gated by nothing but the org-scoped WHERE
 * clause. It now requires `owner` on the conversation itself (ADR-0032): a
 * project member who can merely READ a thread must not be able to destroy it.
 *
 * Two properties, both regressions waiting to happen:
 *   - a non-owner's delete never runs;
 *   - an id that does not exist at all is still a silent no-op, because the chat
 *     store deletes server rows for conversations that may only ever have lived
 *     in the browser.
 *
 * And the property that ties them together (spec SH-6): the two are
 * INDISTINGUISHABLE from outside. The endpoint answers 204 either way, so it
 * cannot be used to sort guessed ids into "real" and "not real". It used to answer
 * 204 for absent and 404 for present-but-not-yours, which is exactly that oracle.
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

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/sharing/repository', () => ({
  findGrantForSubject: vi.fn(),
  countGrantsForResource: vi.fn(),
  // Deleting a conversation purges the collaboration rows that no foreign key
  // can cascade into (grants/requests/items address their target
  // polymorphically). Stubbed here so the purge is observable, not incidental.
  deleteAllGrantsForResource: vi.fn(),
}))
vi.mock('@/lib/mentions/repository', () => ({ deleteRequestsForResource: vi.fn() }))
vi.mock('@/lib/session-documents/repository', () => ({
  // Discarding a chat erases the files attached to it (ADR-0047 Phase 2).
  // Stubbed empty here: the erasure has its own spec, and what matters for
  // these tests is that it runs BEFORE the conversation row goes.
  listSessionDocumentsForCleanup: vi.fn().mockResolvedValue([]),
  deleteSessionDocumentsByIds: vi.fn().mockResolvedValue(undefined),
  SESSION_DOCUMENT_LIST_LIMIT: 100,
}))
vi.mock('@/lib/inbox/repository', () => ({ deleteItemsForResource: vi.fn() }))
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
  // The discard stamps the conversation as deleting BEFORE it erases the files
  // attached to it, so an upload racing the discard has something to refuse on
  // (ADR-0047 Phase 2).
  markConversationDeleting: vi.fn().mockResolvedValue({ id: 'conv_1' }),
  mergeMessageMetadata: vi.fn(),
  updateConversationMetaInOrg: vi.fn(),
  updateConversationTitleInOrg: vi.fn(),
  upsertConversationRead: vi.fn(),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { deleteConversationInOrg, findConversationTenancy } from '@/lib/conversations/repository'
import { deleteAllGrantsForResource, findGrantForSubject } from '@/lib/sharing/repository'
import { deleteRequestsForResource } from '@/lib/mentions/repository'
import { deleteItemsForResource } from '@/lib/inbox/repository'
import { DELETE } from './route'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

const del = () =>
  DELETE(new Request('https://grid.example/api/conversations/conv_1', { method: 'DELETE' }), {
    params: Promise.resolve({ id: 'conv_1' }),
  })

describe('DELETE /api/conversations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' } as never)
    vi.mocked(findGrantForSubject).mockResolvedValue(null)
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'project',
      createdBy: 'user_1',
      deletedAt: null,
    })
    vi.mocked(deleteAllGrantsForResource).mockResolvedValue(0)
    vi.mocked(deleteRequestsForResource).mockResolvedValue(0)
    vi.mocked(deleteItemsForResource).mockResolvedValue(0)
  })

  it('deletes an owned conversation, scoped to the caller organization', async () => {
    const res = await del()

    expect(res.status).toBe(204)
    // Tenant isolation stays in the WHERE clause too: deleting by id alone let
    // any signed-in user delete another org's conversation.
    expect(deleteConversationInOrg).toHaveBeenCalledWith('conv_1', 'org_1')
  })

  it('purges the collaboration rows no foreign key can cascade into', async () => {
    // `resource_shares`, `mention_requests` and `inbox_items` address their
    // target as a polymorphic (resource_type, resource_id) pair, so Postgres
    // cannot cascade them. Forgetting this leaves permanently redacted rows in
    // people's inboxes (spec SH-13, IB-15).
    await del()

    expect(deleteAllGrantsForResource).toHaveBeenCalledWith('conversation', 'conv_1')
    expect(deleteRequestsForResource).toHaveBeenCalledWith('conversation', 'conv_1')
    expect(deleteItemsForResource).toHaveBeenCalledWith('conversation', 'conv_1')
  })

  it('never deletes a conversation the caller does not own', async () => {
    // Previously a 404. That assertion pinned the oracle: the response told the
    // caller the id was real. It is now the same 204 an absent id gets, and the
    // load-bearing part — nothing is destroyed, nothing is purged — is asserted
    // directly instead of being inferred from the status code.
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'project',
      createdBy: 'user_2',
      deletedAt: null,
    })

    const res = await del()

    expect(res.status).toBe(204)
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
    expect(deleteAllGrantsForResource).not.toHaveBeenCalled()
    expect(deleteRequestsForResource).not.toHaveBeenCalled()
    expect(deleteItemsForResource).not.toHaveBeenCalled()
  })

  it('never deletes another organization conversation, and never asks about its project', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_2',
      projectId: PROJECT_ID,
      visibility: 'project',
      createdBy: 'user_1',
      deletedAt: null,
    })

    expect((await del()).status).toBe(204)
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })

  it('stays a no-op for an id that never reached the server', async () => {
    // The chat store deletes ids that may only ever have lived in a browser, so
    // this must not surface an error.
    vi.mocked(findConversationTenancy).mockResolvedValue(null)

    expect((await del()).status).toBe(204)
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })

  it("answers BYTE-IDENTICALLY for an absent id and for one that is not the caller's (spec SH-6)", async () => {
    // The oracle, asserted as one property rather than two statuses: whatever the
    // endpoint says, it must say the same thing in both cases — otherwise a
    // signed-in member can enumerate which conversation ids exist in the org.
    vi.mocked(findConversationTenancy).mockResolvedValue(null)
    const absent = await del()

    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'private',
      createdBy: 'user_2',
      deletedAt: null,
    })
    const forbidden = await del()

    expect(forbidden.status).toBe(absent.status)
    expect(await forbidden.text()).toBe(await absent.text())
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })
})
