/**
 * @vitest-environment node
 */
/**
 * The stopped-answer cut rewrites an answer's text, so who may ask is the
 * point: a collaborator on the conversation, asking about the answer of a
 * turn whose question is their own. What the cut keeps is
 * `lib/conversations/stopped-cut.spec.ts`.
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
const findMessageInConversation = vi.fn()
const reviseMessage = vi.fn()

vi.mock('@/lib/conversations/repository', () => ({
  findConversationTenancy: (...args: unknown[]) => findConversationTenancy(...args),
  findMessageInConversation: (...args: unknown[]) => findMessageInConversation(...args),
  reviseMessage: (...args: unknown[]) => reviseMessage(...args),
  mergeMessageMetadata: vi.fn(),
  findConversationInOrg: vi.fn(),
  findConversationRead: vi.fn(),
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
// Which people may read what the conversation recorded is `restricted-use.spec.ts`'s
// subject (ADR-0088); here nothing it recorded restricts anybody.
vi.mock('@/lib/conversations/restricted-use', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversations/restricted-use')>()),
  peopleWhoMayRead: vi.fn(async (_org: string, _id: string, userIds: readonly string[]) => new Set(userIds)),
  lockedConversationIds: vi.fn(async () => new Set<string>()),
}))
vi.mock('@/lib/sharing/repository', () => ({
  findGrantForSubject: vi.fn(),
  countGrantsForResource: vi.fn(),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { findGrantForSubject } from '@/lib/sharing/repository'
import { answerMessageId } from '@/lib/conversations/stopped-cut'
import { POST } from './route'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const TURN_ID = '4f1a2b3c-1111-4222-8333-444455556666'
const ANSWER_ID = answerMessageId('conv_1', TURN_ID)

const post = (body: unknown, messageId = ANSWER_ID) =>
  POST(
    new Request(`https://grid.example/api/conversations/conv_1/messages/${messageId}/stopped`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'conv_1', messageId }) }
  )

const answer = {
  id: ANSWER_ID,
  conversationId: 'conv_1',
  role: 'assistant',
  content: 'Erster Satz. Zweiter Satz.',
  runId: null,
  metadata: {},
  createdAt: new Date(),
}

describe('POST /api/conversations/[id]/messages/[messageId]/stopped', () => {
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
    findMessageInConversation.mockResolvedValue({ id: TURN_ID, role: 'user', authorUserId: 'user_1' })
    // The repository calls the revision with the stored row under its lock.
    reviseMessage.mockImplementation(async (_conversation, _message, revise) => {
      const revision = revise(answer)
      return revision ? { ...answer, ...revision } : answer
    })
  })

  it("cuts the asker's own answer to the text that was on screen", async () => {
    const res = await post({ turnId: TURN_ID, shown: 'Erster Satz. Zwei' })

    expect(res.status).toBe(200)
    expect(reviseMessage).toHaveBeenCalledWith('conv_1', ANSWER_ID, expect.any(Function))
    await expect(res.json()).resolves.toMatchObject({
      content: 'Erster Satz. Zwei',
      metadata: { provenance: { stopped: true } },
    })
  })

  it('authorizes the conversation as a collaborator before reading any message', async () => {
    findConversationTenancy.mockResolvedValue({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      visibility: 'private',
      createdBy: 'user_2',
      deletedAt: null,
    })
    vi.mocked(findGrantForSubject).mockResolvedValue({ role: 'viewer' } as never)

    const res = await post({ turnId: TURN_ID, shown: 'Erster' })

    expect(res.status).toBe(404)
    expect(findMessageInConversation).not.toHaveBeenCalled()
    expect(reviseMessage).not.toHaveBeenCalled()
  })

  it("403s a collaborator cutting an answer to someone else's question", async () => {
    findMessageInConversation.mockResolvedValue({ id: TURN_ID, role: 'user', authorUserId: 'user_2' })

    const res = await post({ turnId: TURN_ID, shown: 'Erster' })

    expect(res.status).toBe(403)
    expect(reviseMessage).not.toHaveBeenCalled()
  })

  it('404s a message that is not the answer of the named turn', async () => {
    const res = await post({ turnId: TURN_ID, shown: 'Erster' }, '9f1a2b3c-1111-4222-8333-444455556666')

    expect(res.status).toBe(404)
    expect(findMessageInConversation).not.toHaveBeenCalled()
  })

  it('404s a turn whose question is not in the conversation', async () => {
    findMessageInConversation.mockResolvedValue(null)
    expect((await post({ turnId: TURN_ID, shown: 'Erster' })).status).toBe(404)
    expect(reviseMessage).not.toHaveBeenCalled()
  })

  it('409s an answer past the window, and writes nothing', async () => {
    reviseMessage.mockImplementation(async (_conversation, _message, revise) =>
      revise({ ...answer, createdAt: new Date(Date.now() - 60 * 60_000) })
    )
    expect((await post({ turnId: TURN_ID, shown: 'Erster' })).status).toBe(409)
  })

  it('409s a cut that would keep nothing of the answer', async () => {
    const res = await post({ turnId: TURN_ID, shown: 'Ganz anders' })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ details: { reason: 'nothing_shown' } })
  })

  it('400s a malformed id or body instead of failing in SQL', async () => {
    expect((await post({ turnId: TURN_ID, shown: 'x' }, 'not-a-uuid')).status).toBe(400)
    expect((await post({ turnId: 'msg_1', shown: 'x' })).status).toBe(400)
    expect((await post({ turnId: TURN_ID })).status).toBe(400)
    expect(reviseMessage).not.toHaveBeenCalled()
  })
})
