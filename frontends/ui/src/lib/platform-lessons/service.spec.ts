/**
 * The sweep's decision tree — the part of the pipeline where a wrong branch
 * poisons the fleet or silently drops a report. Repository and distiller are
 * mocked; what is under test is which of them gets called with what, per
 * outcome (docs/architecture/platform-failure-learning.md).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
}))
vi.mock('@/lib/authz/platform', () => ({
  requirePlatformPermission: vi.fn(async () => undefined),
  getPlatformOrganizationId: vi.fn(async () => null),
}))
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}))
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: vi.fn(async () => undefined),
}))
vi.mock('./repository', () => ({
  countLessonsByStatus: vi.fn(async () => ({})),
  createLessonFromReport: vi.fn(),
  evictActiveOverCapacity: vi.fn(async () => []),
  expireStaleCandidates: vi.fn(async () => []),
  findLiveLessonByContent: vi.fn(async () => null),
  getLesson: vi.fn(),
  linkReportToLesson: vi.fn(async () => true),
  listActiveLessonsForDigest: vi.fn(async () => []),
  listLessonEvents: vi.fn(async () => []),
  listLessonReports: vi.fn(async () => []),
  listLessons: vi.fn(async () => []),
  listLiveLessons: vi.fn(async () => []),
  listUnprocessedDownvotes: vi.fn(async () => []),
  recordSkippedReport: vi.fn(async () => undefined),
  updateLessonWithEvent: vi.fn(),
}))
vi.mock('./distill-client', () => ({
  distillReport: vi.fn(),
}))

import {
  createLessonFromReport,
  evictActiveOverCapacity,
  expireStaleCandidates,
  findLiveLessonByContent,
  linkReportToLesson,
  listActiveLessonsForDigest,
  listUnprocessedDownvotes,
  recordSkippedReport,
} from './repository'
import { distillReport } from './distill-client'
import {
  buildPlatformLessonsDigest,
  kickLessonDistillation,
  resetLessonSweepStateForTests,
} from './service'
import type { DistillOutcome } from './types'

const DOWNVOTE = {
  feedbackId: 'fb-1',
  organizationId: 'org_abc',
  reason: 'wrong_source',
  comment: 'Falsche Richtlinie zitiert.',
  question: 'Wie lang darf der Fluchtweg sein?',
  answer: 'Laut OIB 4 …',
  createdAt: new Date('2026-08-20T10:00:00Z'),
}

function outcome(overrides: Partial<DistillOutcome>): DistillOutcome {
  return {
    matchLessonId: null,
    lesson: null,
    canonicalSummary: 'Zusammenfassung.',
    category: 'wrong_source',
    generalizable: true,
    auditPassed: true,
    error: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetLessonSweepStateForTests()
})

describe('kickLessonDistillation', () => {
  it('links a matched report to the existing lesson and never creates one', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([DOWNVOTE])
    vi.mocked(distillReport).mockResolvedValue(outcome({ matchLessonId: 'lesson-1' }))

    await kickLessonDistillation()

    expect(linkReportToLesson).toHaveBeenCalledWith(
      'lesson-1',
      expect.objectContaining({ feedbackId: 'fb-1', canonicalSummary: 'Zusammenfassung.' }),
      'system:distiller'
    )
    expect(createLessonFromReport).not.toHaveBeenCalled()
  })

  it('activates a clean-audited generalizable lesson and evicts over capacity', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([DOWNVOTE])
    vi.mocked(distillReport).mockResolvedValue(
      outcome({ lesson: 'Vor dem Zitieren die Richtlinie prüfen.' })
    )
    vi.mocked(createLessonFromReport).mockResolvedValue({
      id: 'lesson-new',
      status: 'active',
    } as Awaited<ReturnType<typeof createLessonFromReport>>)

    await kickLessonDistillation()

    expect(createLessonFromReport).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', heldReason: null, actor: 'system:distiller' })
    )
    expect(evictActiveOverCapacity).toHaveBeenCalled()
  })

  it('holds an audit-flagged lesson back as a candidate', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([DOWNVOTE])
    vi.mocked(distillReport).mockResolvedValue(
      outcome({ lesson: 'Lektion.', auditPassed: false })
    )
    vi.mocked(createLessonFromReport).mockResolvedValue({
      id: 'lesson-new',
      status: 'candidate',
    } as Awaited<ReturnType<typeof createLessonFromReport>>)

    await kickLessonDistillation()

    expect(createLessonFromReport).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'candidate', heldReason: 'audit_flagged' })
    )
    expect(evictActiveOverCapacity).not.toHaveBeenCalled()
  })

  it('records a non-generalizable report as skipped, without creating anything', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([DOWNVOTE])
    vi.mocked(distillReport).mockResolvedValue(outcome({ generalizable: false }))

    await kickLessonDistillation()

    expect(recordSkippedReport).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: 'not_generalizable' })
    )
    expect(createLessonFromReport).not.toHaveBeenCalled()
  })

  it('skips a bare thumb with no signal without spending an LLM call', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([
      { ...DOWNVOTE, reason: null, comment: null, question: null, answer: null },
    ])

    await kickLessonDistillation()

    expect(distillReport).not.toHaveBeenCalled()
    expect(recordSkippedReport).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: 'no_signal' })
    )
  })

  it('defers a report on distiller error — no record, so a later sweep retries', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([DOWNVOTE])
    vi.mocked(distillReport).mockResolvedValue(outcome({ error: 'backend_unreachable' }))

    await kickLessonDistillation()

    expect(recordSkippedReport).not.toHaveBeenCalled()
    expect(createLessonFromReport).not.toHaveBeenCalled()
    expect(linkReportToLesson).not.toHaveBeenCalled()
  })

  it('links via the normalized exact-duplicate backstop when the matcher missed', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([DOWNVOTE])
    vi.mocked(distillReport).mockResolvedValue(outcome({ lesson: 'Bestehende Lektion.' }))
    vi.mocked(findLiveLessonByContent).mockResolvedValue({
      id: 'lesson-existing',
    } as Awaited<ReturnType<typeof findLiveLessonByContent>>)

    await kickLessonDistillation()

    expect(linkReportToLesson).toHaveBeenCalledWith(
      'lesson-existing',
      expect.anything(),
      'system:distiller'
    )
    expect(createLessonFromReport).not.toHaveBeenCalled()
  })

  it('pseudonymizes the organization: the hash reaches storage, the id never does', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([DOWNVOTE])
    vi.mocked(distillReport).mockResolvedValue(outcome({ generalizable: false }))

    await kickLessonDistillation()

    const stored = vi.mocked(recordSkippedReport).mock.calls[0][0]
    expect(stored.orgHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.orgHash).not.toContain('org_abc')
    expect(JSON.stringify(stored)).not.toContain('org_abc')
  })

  it('scrubs PII from the report before it reaches the distiller', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([
      { ...DOWNVOTE, comment: 'Kontakt: office@planbau.at, falsche Antwort.' },
    ])
    vi.mocked(distillReport).mockResolvedValue(outcome({ generalizable: false }))

    await kickLessonDistillation()

    const request = vi.mocked(distillReport).mock.calls[0][0]
    expect(request.comment).not.toContain('office@planbau.at')
  })

  it('never throws — a broken pipeline must not break voting', async () => {
    vi.mocked(listUnprocessedDownvotes).mockRejectedValue(new Error('db down'))
    await expect(kickLessonDistillation()).resolves.toBeUndefined()
  })

  it('expires stale candidates on every sweep, before processing', async () => {
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([])
    await kickLessonDistillation()
    expect(expireStaleCandidates).toHaveBeenCalled()
  })

  it('stops retrying a report this process has failed on three times', async () => {
    // A permanently failing report at the oldest-first head must not wedge
    // the queue: after MAX_ATTEMPTS_PER_PROCESS deferrals it is skipped and
    // the reports behind it get the slots.
    vi.mocked(listUnprocessedDownvotes).mockResolvedValue([DOWNVOTE])
    vi.mocked(distillReport).mockResolvedValue(outcome({ error: 'llm_request_failed' }))
    for (let attempt = 0; attempt < 3; attempt++) await kickLessonDistillation()
    expect(distillReport).toHaveBeenCalledTimes(3)

    await kickLessonDistillation()
    expect(distillReport).toHaveBeenCalledTimes(3)
  })

  it('collapses concurrent kicks into one sweep', async () => {
    vi.mocked(listUnprocessedDownvotes).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 10))
    )
    await Promise.all([kickLessonDistillation(), kickLessonDistillation(), kickLessonDistillation()])
    expect(listUnprocessedDownvotes).toHaveBeenCalledTimes(1)
  })
})

describe('buildPlatformLessonsDigest', () => {
  it('formats active lessons as the bounded injectable digest', async () => {
    vi.mocked(listActiveLessonsForDigest).mockResolvedValue([
      {
        category: 'wrong_source',
        reportCount: 3,
        content: 'Vor dem Zitieren die Richtlinie prüfen.',
      },
    ] as Awaited<ReturnType<typeof listActiveLessonsForDigest>>)

    const digest = await buildPlatformLessonsDigest()
    expect(digest).toBe(
      'PLATFORM_LESSONS v1\n- [wrong_source | 3x] "Vor dem Zitieren die Richtlinie prüfen."'
    )
  })

  it('returns null when no lesson is active', async () => {
    vi.mocked(listActiveLessonsForDigest).mockResolvedValue([])
    expect(await buildPlatformLessonsDigest()).toBeNull()
  })
})
