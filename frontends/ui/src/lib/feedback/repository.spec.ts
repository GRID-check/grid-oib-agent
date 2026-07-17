import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '@/lib/db'
import {
  CONVERSATION_FEEDBACK_LIST_LIMIT,
  deleteAnswerFeedbackForUser,
  listAnswerFeedbackForConversation,
  upsertAnswerFeedback,
} from './repository'

const mockGetDb = vi.mocked(getDb)

const values = {
  organizationId: 'org_1',
  projectId: null,
  conversationId: 'conv_1',
  messageId: 'msg_1',
  userId: 'user_1',
  verdict: 'up' as const,
  reason: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('upsertAnswerFeedback', () => {
  it('inserts with ON CONFLICT (user_id, message_id) DO UPDATE', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'fb_1', ...values }])
    const onConflictDoUpdate = vi.fn(() => ({ returning }))
    const valuesFn = vi.fn(() => ({ onConflictDoUpdate }))
    mockGetDb.mockReturnValue({ insert: vi.fn(() => ({ values: valuesFn })) } as never)

    const row = await upsertAnswerFeedback(values)

    expect(valuesFn).toHaveBeenCalledWith(values)
    // Conflict target pins the row to the voting user (one vote per answer).
    const config = onConflictDoUpdate.mock.calls[0]![0] as unknown as {
      target: unknown[]
      set: Record<string, unknown>
    }
    expect(config.target).toHaveLength(2)
    expect(config.set).toMatchObject({ verdict: 'up', reason: null, organizationId: 'org_1' })
    expect(config.set.updatedAt).toBeInstanceOf(Date)
    expect(row.id).toBe('fb_1')
  })
})

describe('deleteAnswerFeedbackForUser', () => {
  function mockDelete(rows: unknown[]) {
    const returning = vi.fn().mockResolvedValue(rows)
    const where = vi.fn(() => ({ returning }))
    mockGetDb.mockReturnValue({ delete: vi.fn(() => ({ where })) } as never)
    return { where }
  }

  it('returns true when a row was deleted (scoped user + message + org)', async () => {
    const { where } = mockDelete([{ id: 'fb_1' }])
    await expect(deleteAnswerFeedbackForUser('user_1', 'msg_1', 'org_1')).resolves.toBe(true)
    expect(where).toHaveBeenCalledTimes(1)
    expect(where.mock.calls[0]![0]).toBeDefined() // and(user, message, org)
  })

  it('returns false when nothing matched', async () => {
    mockDelete([])
    await expect(deleteAnswerFeedbackForUser('user_1', 'msg_gone', 'org_1')).resolves.toBe(false)
  })
})

describe('listAnswerFeedbackForConversation', () => {
  it('is bounded by the hard cap and scoped by org + user + conversation', async () => {
    const limit = vi.fn().mockResolvedValue([])
    const orderBy = vi.fn(() => ({ limit }))
    const where = vi.fn(() => ({ orderBy }))
    const from = vi.fn(() => ({ where }))
    mockGetDb.mockReturnValue({ select: vi.fn(() => ({ from })) } as never)

    await listAnswerFeedbackForConversation('user_1', 'conv_1', 'org_1')

    expect(where).toHaveBeenCalledTimes(1)
    expect(limit).toHaveBeenCalledWith(CONVERSATION_FEEDBACK_LIST_LIMIT)
  })
})
