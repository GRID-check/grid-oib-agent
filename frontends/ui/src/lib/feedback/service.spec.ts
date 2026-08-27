/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-viewer' }),
}))

vi.mock('./repository', () => ({
  upsertAnswerFeedback: vi.fn(),
  deleteAnswerFeedbackForUser: vi.fn(),
  listAnswerFeedbackForConversation: vi.fn(),
  getFeedbackHealth: vi.fn(),
  listFeedbackTurns: vi.fn(),
}))

vi.mock('./digest', () => ({ getFeedbackDigest: vi.fn() }))

vi.mock('@/lib/authz/platform', () => ({
  requirePlatformPermission: vi.fn(),
  PlatformAccessDeniedError: class PlatformAccessDeniedError extends Error {},
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { PlatformAccessDeniedError, requirePlatformPermission } from '@/lib/authz/platform'
import {
  deleteAnswerFeedbackForUser,
  getFeedbackHealth,
  listAnswerFeedbackForConversation,
  upsertAnswerFeedback,
} from './repository'
import { getFeedbackDigest } from './digest'
import {
  getAnswerFeedbackDigest,
  getAnswerFeedbackHealth,
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
  comment: null,
  // No experiment arm: the holdout is off by default (see
  // lib/platform-lessons/holdout.ts), so an ordinary vote carries null.
  lessonsHoldout: null,
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
      comment: null,
      conversationId: 'conv_1',
      lessonsHoldout: null,
      projectId: null,
    })
    expect(view).toEqual({ messageId: 'msg_1', verdict: 'up', reason: null, comment: null })
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
    expect(view).toEqual({ messageId: 'msg_1', verdict: 'down', reason: 'inaccurate', comment: null })
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
      { messageId: 'msg_1', verdict: 'up', reason: null, comment: null },
      { messageId: 'msg_2', verdict: 'down', reason: 'too_slow', comment: null },
    ])
  })
})

/**
 * The cross-tenant read. Every other query in this domain is scoped by
 * organizationId in SQL; this one is not scoped at all, so `requirePlatformPermission`
 * IS its tenancy boundary — these two tests are the whole of what stops one
 * organization's feedback reaching another.
 */
describe('getAnswerFeedbackHealth', () => {
  beforeEach(() => {
    vi.mocked(requirePlatformPermission).mockReset()
    vi.mocked(getFeedbackHealth).mockReset()
  })

  it('refuses anyone who is not a platform owner, and does not read first', async () => {
    vi.mocked(requirePlatformPermission).mockRejectedValue(new PlatformAccessDeniedError())

    await expect(getAnswerFeedbackHealth({} as never)).rejects.toBeInstanceOf(
      PlatformAccessDeniedError,
    )
    // The guard runs BEFORE the unscoped query — a refusal must not still have
    // touched every tenant's rows.
    expect(getFeedbackHealth).not.toHaveBeenCalled()
  })

  it('reads for a platform owner', async () => {
    vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
    vi.mocked(getFeedbackHealth).mockResolvedValue({
      windowDays: 30,
      totals: { up: 4, down: 1 },
      reasons: [],
      daily: [],
      organizations: [],
      topics: [],
      turns: [],
    } as never)

    const health = await getAnswerFeedbackHealth({} as never)

    expect(health.totals).toEqual({ up: 4, down: 1 })
    expect(requirePlatformPermission).toHaveBeenCalledOnce()
  })
})

/**
 * The digest reads across every tenant's questions at once and hands a summary
 * of all of them to a model — so it needs the same gate as the numbers, and
 * needs it to run BEFORE anything is read or sent.
 */
describe('getAnswerFeedbackDigest', () => {
  beforeEach(() => {
    vi.mocked(requirePlatformPermission).mockReset()
    vi.mocked(getFeedbackHealth).mockReset()
    vi.mocked(getFeedbackDigest).mockReset()
  })

  it('refuses anyone who is not a platform owner, and neither reads nor summarises', async () => {
    vi.mocked(requirePlatformPermission).mockRejectedValue(new PlatformAccessDeniedError())

    await expect(getAnswerFeedbackDigest({} as never)).rejects.toBeInstanceOf(
      PlatformAccessDeniedError,
    )
    expect(getFeedbackHealth).not.toHaveBeenCalled()
    expect(getFeedbackDigest).not.toHaveBeenCalled()
  })

  it('summarises the SAME aggregate the page shows, and skips the drill-in rows', async () => {
    vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
    const health = { windowDays: 30, totals: { up: 9, down: 1 } } as never
    vi.mocked(getFeedbackHealth).mockResolvedValue(health)
    vi.mocked(getFeedbackDigest).mockResolvedValue({ digest: null, error: 'too_few_votes' })

    const result = await getAnswerFeedbackDigest({} as never, { windowDays: 7 }, { locale: 'en' })

    // `limit: 0` — the digest samples its own turns in both directions, so the
    // aggregate read must not also pay for a drill-in nobody will look at.
    expect(getFeedbackHealth).toHaveBeenCalledWith({ windowDays: 7, limit: 0 })
    expect(getFeedbackDigest).toHaveBeenCalledWith(health, { windowDays: 7 }, { locale: 'en' })
    expect(result).toEqual({ digest: null, error: 'too_few_votes' })
  })
})
