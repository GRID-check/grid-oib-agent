import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-viewer' }),
}))

vi.mock('./repository', () => ({
  upsertAnswerFeedback: vi.fn(),
  deleteAnswerFeedbackForUser: vi.fn(),
  listAnswerFeedbackForConversation: vi.fn(),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  deleteAnswerFeedbackForUser,
  listAnswerFeedbackForConversation,
  upsertAnswerFeedback,
} from './repository'
import {
  getOwnConversationFeedback,
  retractAnswerFeedback,
  submitAnswerFeedback,
} from './service'

const mockRequireProjectAccess = vi.mocked(requireProjectAccess)
const mockUpsert = vi.mocked(upsertAnswerFeedback)
const mockDelete = vi.mocked(deleteAnswerFeedbackForUser)
const mockList = vi.mocked(listAnswerFeedbackForConversation)

const session = {
  userId: 'user_1',
  email: 'user@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [] as string[],
  featureFlags: null,
} as unknown as AuthorizedSession

const storedRow = {
  id: 'fb_1',
  organizationId: 'org_1',
  projectId: null,
  conversationId: 'conv_1',
  messageId: 'msg_1',
  userId: 'user_1',
  verdict: 'up' as const,
  reason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireProjectAccess.mockResolvedValue({ role: 'project-viewer' } as never)
  mockUpsert.mockResolvedValue(storedRow)
})

describe('submitAnswerFeedback', () => {
  it('upserts an up vote scoped to the session user + org', async () => {
    const view = await submitAnswerFeedback(session, {
      messageId: 'msg_1',
      verdict: 'up',
      conversationId: 'conv_1',
    })

    expect(mockUpsert).toHaveBeenCalledWith({
      organizationId: 'org_1',
      userId: 'user_1',
      messageId: 'msg_1',
      verdict: 'up',
      reason: null,
      conversationId: 'conv_1',
      projectId: null,
    })
    expect(view).toEqual({ messageId: 'msg_1', verdict: 'up', reason: null })
    expect(mockRequireProjectAccess).not.toHaveBeenCalled()
  })

  it('persists the reason for a down vote', async () => {
    mockUpsert.mockResolvedValue({ ...storedRow, verdict: 'down', reason: 'inaccurate' })

    const view = await submitAnswerFeedback(session, {
      messageId: 'msg_1',
      verdict: 'down',
      reason: 'inaccurate',
    })

    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'down', reason: 'inaccurate' }))
    expect(view).toEqual({ messageId: 'msg_1', verdict: 'down', reason: 'inaccurate' })
  })

  it('accepts a down vote without a reason (reason arrives on chip click)', async () => {
    await submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'down' })
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'down', reason: null }))
  })

  it('rejects a reason on an up vote', async () => {
    await expect(
      submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'up', reason: 'inaccurate' }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('rejects unknown verdicts and reasons (defense in depth beyond zod)', async () => {
    await expect(
      submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'meh' as never }),
    ).rejects.toBeInstanceOf(BadRequestError)
    await expect(
      submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'down', reason: 'nope' as never }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('enforces project access when a projectId is present', async () => {
    await submitAnswerFeedback(session, {
      messageId: 'msg_1',
      verdict: 'up',
      projectId: '00000000-0000-0000-0000-000000000001',
    })
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(
      session,
      '00000000-0000-0000-0000-000000000001',
      'project:view',
    )
  })

  it('propagates the access denial (404) without writing', async () => {
    mockRequireProjectAccess.mockRejectedValue(new NotFoundError())
    await expect(
      submitAnswerFeedback(session, {
        messageId: 'msg_1',
        verdict: 'up',
        projectId: '00000000-0000-0000-0000-000000000001',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(mockUpsert).not.toHaveBeenCalled()
  })
})

describe('retractAnswerFeedback', () => {
  it('deletes the vote scoped to the session user + org', async () => {
    mockDelete.mockResolvedValue(true)
    await retractAnswerFeedback(session, 'msg_1')
    expect(mockDelete).toHaveBeenCalledWith('user_1', 'msg_1', 'org_1')
  })

  it('is idempotent — retracting a non-existent vote is a success', async () => {
    mockDelete.mockResolvedValue(false)
    await expect(retractAnswerFeedback(session, 'msg_gone')).resolves.toBeUndefined()
  })
})

describe('getOwnConversationFeedback', () => {
  it('returns the caller-scoped votes mapped to the wire shape', async () => {
    mockList.mockResolvedValue([
      storedRow,
      { ...storedRow, id: 'fb_2', messageId: 'msg_2', verdict: 'down', reason: 'too_slow' },
    ])

    const views = await getOwnConversationFeedback(session, 'conv_1')

    expect(mockList).toHaveBeenCalledWith('user_1', 'conv_1', 'org_1')
    expect(views).toEqual([
      { messageId: 'msg_1', verdict: 'up', reason: null },
      { messageId: 'msg_2', verdict: 'down', reason: 'too_slow' },
    ])
  })
})
