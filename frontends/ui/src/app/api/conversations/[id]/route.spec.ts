/**
 * Deleting a conversation used to be gated by nothing but the org-scoped WHERE
 * clause. It now requires `owner` on the conversation itself (ADR-0032): a
 * project member who can merely READ a thread must not be able to destroy it.
 *
 * Two properties, both regressions waiting to happen:
 *   - a non-owner gets a 404 and the delete never runs;
 *   - an id that does not exist at all is still a silent no-op, because the chat
 *     store deletes server rows for conversations that may only ever have lived
 *     in the browser.
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

import { requireProjectAccess } from '@/lib/authz/projects'
import { deleteConversationInOrg, findConversationTenancy } from '@/lib/conversations/repository'
import { findGrantForSubject } from '@/lib/sharing/repository'
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
  })

  it('deletes an owned conversation, scoped to the caller organization', async () => {
    const res = await del()

    expect(res.status).toBe(204)
    // Tenant isolation stays in the WHERE clause too: deleting by id alone let
    // any signed-in user delete another org's conversation.
    expect(deleteConversationInOrg).toHaveBeenCalledWith('conv_1', 'org_1')
  })

  it('404s a conversation the caller does not own, and never deletes it', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'project',
      createdBy: 'user_2',
      deletedAt: null,
    })

    const res = await del()

    expect(res.status).toBe(404)
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })

  it('404s another organization conversation without asking about the project', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_2',
      projectId: PROJECT_ID,
      visibility: 'project',
      createdBy: 'user_1',
      deletedAt: null,
    })

    expect((await del()).status).toBe(404)
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })

  it('stays a no-op for an id that never reached the server', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue(null)

    expect((await del()).status).toBe(204)
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })
})
