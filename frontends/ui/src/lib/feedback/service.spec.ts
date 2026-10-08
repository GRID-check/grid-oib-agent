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
  getAnswerFeedbackForUser: vi.fn(async () => null),
  getAnswerTraceId: vi.fn(async () => null),
  listAnswerFeedbackForConversation: vi.fn(),
  getFeedbackHealth: vi.fn(),
  listFeedbackTurns: vi.fn(),
  FEEDBACK_EXPORT_ROW_CAP: 3,
}))

// The memory-implication trigger: mocked wholesale — its own behavior is
// covered in memory-service.spec; here only the firing conditions matter.
vi.mock('@/lib/projects/memory-service', () => ({
  implicateMemoryFromFeedback: vi.fn(async () => 0),
}))

// The voter's folder clearance (ADR-0086), decided in the projects service.
vi.mock('@/lib/projects/service', () => ({
  memoryClearance: vi.fn(async () => ({ cleared: ['00000000-0000-4000-8000-0000000000aa'] })),
}))

// The office's chat screening (ADR-0085): the REAL matcher over Piloti's
// suggested list, with no database behind it.
vi.mock('@/lib/upload-screening/service', async () => {
  const { chatScreeningRules, maskText } = await import('@/lib/upload-screening/content-screen')
  const { SUGGESTED_SCREENING_POLICY } = await import('@/lib/upload-screening/policy')
  return {
    maskChatText: vi.fn(async (_organizationId: string, text: string) =>
      maskText(text, chatScreeningRules(SUGGESTED_SCREENING_POLICY))
    ),
  }
})

vi.mock('./digest', () => ({ getFeedbackDigest: vi.fn() }))

// The Langfuse client: its own behaviour is pinned in lib/langfuse/*.spec.ts;
// here only when the service calls it, with what, and that it never waits on it.
vi.mock('@/lib/langfuse/feedback-score', () => ({
  feedbackScoringEnabled: vi.fn(() => true),
  upsertFeedbackScore: vi.fn(async () => true),
  deleteFeedbackScore: vi.fn(async () => true),
}))

vi.mock('@/lib/organizations/display-names', () => ({
  getOrganizationDisplayNames: vi.fn(async () => new Map<string, string>()),
}))

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
  getAnswerFeedbackForUser,
  getAnswerTraceId,
  getFeedbackHealth,
  listAnswerFeedbackForConversation,
  listFeedbackTurns,
  upsertAnswerFeedback,
} from './repository'
import { implicateMemoryFromFeedback } from '@/lib/projects/memory-service'
import { memoryClearance } from '@/lib/projects/service'
import { getFeedbackDigest } from './digest'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import {
  deleteFeedbackScore,
  feedbackScoringEnabled,
  upsertFeedbackScore,
} from '@/lib/langfuse/feedback-score'
import {
  getAnswerFeedbackDigest,
  getAnswerFeedbackExport,
  getAnswerFeedbackHealth,
  getOwnConversationFeedback,
  retractAnswerFeedback,
  submitAnswerFeedback,
} from './service'

const mockRequireProjectAccess = vi.mocked(requireProjectAccess)
const mockUpsert = vi.mocked(upsertAnswerFeedback)
const mockGetPrior = vi.mocked(getAnswerFeedbackForUser)
const mockImplicate = vi.mocked(implicateMemoryFromFeedback)
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
  expectedAnswer: null,
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
  mockGetPrior.mockResolvedValue(null)
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
      expectedAnswer: null,
      conversationId: 'conv_1',
      lessonsHoldout: null,
      projectId: null,
    })
    expect(view).toEqual({
      messageId: 'msg_1',
      verdict: 'up',
      reason: null,
      comment: null,
      expectedAnswer: null,
    })
    expect(mockRequireProjectAccess).not.toHaveBeenCalled()
  })

  it('persists the reason for a down vote', async () => {
    mockUpsert.mockResolvedValue({ ...storedRow, verdict: 'down', reason: 'inaccurate' })

    const view = await submitAnswerFeedback(session, {
      messageId: 'msg_1',
      verdict: 'down',
      reason: 'inaccurate',
    })

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'down', reason: 'inaccurate' })
    )
    expect(view).toEqual({
      messageId: 'msg_1',
      verdict: 'down',
      reason: 'inaccurate',
      comment: null,
      expectedAnswer: null,
    })
  })

  it('accepts a down vote without a reason (reason arrives on chip click)', async () => {
    await submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'down' })
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'down', reason: null })
    )
  })

  it('implicates memory when a down vote carries new comment text', async () => {
    mockUpsert.mockResolvedValue({
      ...storedRow,
      verdict: 'down',
      reason: 'inaccurate',
      comment: 'OIB 4 falsch zitiert',
      projectId: 'proj_1',
    })
    await submitAnswerFeedback(session, {
      messageId: 'msg_1',
      verdict: 'down',
      reason: 'inaccurate',
      comment: 'OIB 4 falsch zitiert',
      projectId: 'proj_1',
    })
    // Among the notes this voter may see (ADR-0086): their clearance rides along.
    await vi.waitFor(() =>
      expect(mockImplicate).toHaveBeenCalledWith({
        organizationId: 'org_1',
        projectId: 'proj_1',
        comment: 'OIB 4 falsch zitiert',
        readableFolderIds: ['00000000-0000-4000-8000-0000000000aa'],
      })
    )
    expect(memoryClearance).toHaveBeenCalledWith(session, 'proj_1')
  })

  it('implicates open organization notes only for a vote outside a project', async () => {
    mockUpsert.mockResolvedValue({ ...storedRow, verdict: 'down', comment: 'falsch' })
    await submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'down', comment: 'falsch' })
    await vi.waitFor(() =>
      expect(mockImplicate).toHaveBeenCalledWith(expect.objectContaining({ readableFolderIds: [] }))
    )
    expect(memoryClearance).not.toHaveBeenCalled()
  })

  it("stores a down-vote comment masked against the office's policy (ADR-0086)", async () => {
    await submitAnswerFeedback(session, {
      messageId: 'msg_1',
      verdict: 'down',
      comment: 'Die IBAN AT61 1904 3002 3457 3201 aus dem Lohnzettel fehlt',
    })
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ comment: 'Die IBAN [IBAN entfernt] aus dem [Begriff entfernt] fehlt' })
    )
  })

  it('stores the expected answer masked too: it becomes an eval case a model answers', async () => {
    await submitAnswerFeedback(session, {
      messageId: 'msg_1',
      verdict: 'down',
      expectedAnswer: 'Die Honorarnote an IBAN AT61 1904 3002 3457 3201',
    })
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAnswer: 'Die [Begriff entfernt] an IBAN [IBAN entfernt]' })
    )
  })

  it('does not implicate memory again for an unchanged re-vote comment', async () => {
    mockGetPrior.mockResolvedValue({ ...storedRow, verdict: 'down', comment: 'gleich' })
    mockUpsert.mockResolvedValue({ ...storedRow, verdict: 'down', comment: 'gleich' })
    await submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'down', comment: 'gleich' })
    expect(mockImplicate).not.toHaveBeenCalled()
  })

  it('never implicates memory on an up vote or a comment-less down vote', async () => {
    await submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'up' })
    mockUpsert.mockResolvedValue({ ...storedRow, verdict: 'down' })
    await submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'down' })
    expect(mockImplicate).not.toHaveBeenCalled()
  })

  it('rejects a reason on an up vote', async () => {
    await expect(
      submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'up', reason: 'inaccurate' })
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('rejects unknown verdicts and reasons (defense in depth beyond zod)', async () => {
    await expect(
      submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'meh' as never })
    ).rejects.toBeInstanceOf(BadRequestError)
    await expect(
      submitAnswerFeedback(session, {
        messageId: 'msg_1',
        verdict: 'down',
        reason: 'nope' as never,
      })
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
      'project:view'
    )
  })

  it('propagates the access denial (404) without writing', async () => {
    mockRequireProjectAccess.mockRejectedValue(new NotFoundError())
    await expect(
      submitAnswerFeedback(session, {
        messageId: 'msg_1',
        verdict: 'up',
        projectId: '00000000-0000-0000-0000-000000000001',
      })
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(mockUpsert).not.toHaveBeenCalled()
  })
})

describe('retractAnswerFeedback', () => {
  it('deletes the vote scoped to the session user + org', async () => {
    mockDelete.mockResolvedValue('fb_1')
    await retractAnswerFeedback(session, 'msg_1')
    expect(mockDelete).toHaveBeenCalledWith('user_1', 'msg_1', 'org_1')
  })

  it('is idempotent — retracting a non-existent vote is a success', async () => {
    mockDelete.mockResolvedValue(null)
    await expect(retractAnswerFeedback(session, 'msg_gone')).resolves.toBeUndefined()
    expect(deleteFeedbackScore).not.toHaveBeenCalled()
  })

  it("deletes the vote's Langfuse score by the deleted row's id", async () => {
    mockDelete.mockResolvedValue('fb_1')
    await retractAnswerFeedback(session, 'msg_1')
    expect(deleteFeedbackScore).toHaveBeenCalledWith('fb_1')
  })

  it('does not wait for Langfuse to answer the retraction', async () => {
    mockDelete.mockResolvedValue('fb_1')
    vi.mocked(deleteFeedbackScore).mockReturnValueOnce(new Promise(() => {}))
    await expect(retractAnswerFeedback(session, 'msg_1')).resolves.toBeUndefined()
  })
})

/**
 * Every vote also lands in Langfuse as a score on its answer's trace
 * (ADR-0044, Amendment 3), after the database write and never in its way.
 */
describe('submitAnswerFeedback -> Langfuse score', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('scores the trace the answer row names, keyed by the feedback row', async () => {
    vi.mocked(getAnswerTraceId).mockResolvedValueOnce('6135ac80f26d5f7dab0f1633fe313293')
    mockUpsert.mockResolvedValueOnce({
      ...storedRow,
      verdict: 'down',
      reason: 'inaccurate',
      comment: 'R 60, nicht R 90',
    })

    await submitAnswerFeedback(session, {
      messageId: 'msg_1',
      verdict: 'down',
      reason: 'inaccurate',
      comment: 'R 60, nicht R 90',
    })
    await flush()

    expect(getAnswerTraceId).toHaveBeenCalledWith('msg_1', 'org_1')
    expect(upsertFeedbackScore).toHaveBeenCalledWith({
      feedbackId: 'fb_1',
      traceId: '6135ac80f26d5f7dab0f1633fe313293',
      verdict: 'down',
      reason: 'inaccurate',
      comment: 'R 60, nicht R 90',
      expectedAnswer: null,
    })
  })

  it('sends nothing when the answer row names no trace', async () => {
    vi.mocked(getAnswerTraceId).mockResolvedValueOnce(null)
    await submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'up' })
    await flush()
    expect(upsertFeedbackScore).not.toHaveBeenCalled()
  })

  it('does not even look the trace up when Langfuse is not configured', async () => {
    vi.mocked(feedbackScoringEnabled).mockReturnValueOnce(false)
    await submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'up' })
    await flush()
    expect(getAnswerTraceId).not.toHaveBeenCalled()
    expect(upsertFeedbackScore).not.toHaveBeenCalled()
  })

  it('returns the vote without waiting for Langfuse, and survives its failure', async () => {
    vi.mocked(getAnswerTraceId).mockResolvedValueOnce('6135ac80f26d5f7dab0f1633fe313293')
    vi.mocked(upsertFeedbackScore).mockReturnValueOnce(new Promise(() => {}))
    await expect(
      submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'up' })
    ).resolves.toMatchObject({
      verdict: 'up',
    })

    vi.mocked(getAnswerTraceId).mockRejectedValueOnce(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      submitAnswerFeedback(session, { messageId: 'msg_1', verdict: 'up' })
    ).resolves.toMatchObject({
      verdict: 'up',
    })
    await flush()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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
      { messageId: 'msg_1', verdict: 'up', reason: null, comment: null, expectedAnswer: null },
      {
        messageId: 'msg_2',
        verdict: 'down',
        reason: 'too_slow',
        comment: null,
        expectedAnswer: null,
      },
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
      PlatformAccessDeniedError
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

  /** The platform view links each rated turn to its trace, and the project to its scores. */
  it('links turns to their Langfuse traces when the UI is configured, and not otherwise', async () => {
    vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
    const health = {
      windowDays: 30,
      totals: { up: 0, down: 2 },
      reasons: [],
      daily: [],
      organizations: [],
      topics: [],
      turns: [
        {
          id: 'fb_1',
          organizationId: 'org_1',
          messageId: 'm1',
          traceId: '6135ac80f26d5f7dab0f1633fe313293',
        },
        { id: 'fb_2', organizationId: 'org_1', messageId: 'm2', traceId: null },
      ],
    }
    vi.mocked(getFeedbackHealth).mockResolvedValue(health as never)

    vi.stubEnv('LANGFUSE_PUBLIC_URL', 'https://langfuse.example.at/')
    vi.stubEnv('LANGFUSE_PROJECT_ID', 'grid')
    try {
      const linked = await getAnswerFeedbackHealth({} as never)
      expect(linked.turns.map((turn) => turn.langfuseTraceUrl)).toEqual([
        'https://langfuse.example.at/project/grid/traces/6135ac80f26d5f7dab0f1633fe313293',
        null,
      ])
      expect(linked.langfuse).toEqual({ projectUrl: 'https://langfuse.example.at/project/grid' })

      vi.stubEnv('LANGFUSE_PROJECT_ID', '')
      const unlinked = await getAnswerFeedbackHealth({} as never)
      expect(unlinked.turns.map((turn) => turn.langfuseTraceUrl)).toEqual([null, null])
      expect(unlinked.langfuse).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  /** A raw `org_arch_buero` tells the platform owner nothing; the name does. */
  it('names every organization in the rollup and in the drill-in, null where unknown', async () => {
    vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
    vi.mocked(getOrganizationDisplayNames).mockResolvedValue(
      new Map([['org_arch_buero', 'Architekturbüro Huber']])
    )
    vi.mocked(getFeedbackHealth).mockResolvedValue({
      windowDays: 30,
      totals: { up: 0, down: 2 },
      reasons: [],
      daily: [],
      organizations: [
        { organizationId: 'org_arch_buero', up: 0, down: 1, voters: 1 },
        { organizationId: 'org_gone', up: 0, down: 1, voters: 1 },
      ],
      topics: [],
      turns: [
        { id: 'fb_1', organizationId: 'org_arch_buero', messageId: 'm1' },
        { id: 'fb_2', organizationId: 'org_gone', messageId: 'm2' },
      ],
    } as never)

    const health = await getAnswerFeedbackHealth({} as never)

    expect(health.organizations.map((org) => org.organizationName)).toEqual([
      'Architekturbüro Huber',
      null,
    ])
    expect(health.turns.map((turn) => turn.organizationName)).toEqual([
      'Architekturbüro Huber',
      null,
    ])
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
      PlatformAccessDeniedError
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

/**
 * The export used to read through the health view and so stopped at the page's
 * 50 rows without a word. It has its own bound now, and reports hitting it.
 */
describe('getAnswerFeedbackExport', () => {
  beforeEach(() => {
    vi.mocked(requirePlatformPermission).mockReset()
    vi.mocked(listFeedbackTurns).mockReset()
  })

  it('refuses anyone who is not a platform owner, and does not read first', async () => {
    vi.mocked(requirePlatformPermission).mockRejectedValue(new PlatformAccessDeniedError())

    await expect(getAnswerFeedbackExport({} as never)).rejects.toBeInstanceOf(
      PlatformAccessDeniedError
    )
    expect(listFeedbackTurns).not.toHaveBeenCalled()
  })

  it('reads one row past the cap, keeps the filters, and reports a cut', async () => {
    vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
    vi.mocked(listFeedbackTurns).mockResolvedValue([
      { id: '1' },
      { id: '2' },
      { id: '3' },
      { id: '4' },
    ] as never)

    const exported = await getAnswerFeedbackExport({} as never, { windowDays: 90, verdict: 'up' })

    expect(listFeedbackTurns).toHaveBeenCalledWith({ windowDays: 90, verdict: 'up', limit: 4 })
    expect(exported.turns).toHaveLength(3)
    expect(exported).toMatchObject({ truncated: true, cap: 3 })
  })

  it('does not report a cut when the window fit exactly', async () => {
    vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
    vi.mocked(listFeedbackTurns).mockResolvedValue([{ id: '1' }, { id: '2' }, { id: '3' }] as never)

    const exported = await getAnswerFeedbackExport({} as never)

    expect(exported.turns).toHaveLength(3)
    expect(exported.truncated).toBe(false)
  })
})
