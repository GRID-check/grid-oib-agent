/**
 * Platform-lessons repository — the only module that queries the three
 * `platform_lesson*` tables (ADR-0017;
 * docs/architecture/platform-failure-learning.md).
 *
 * Every function here runs cross-tenant BY DESIGN: the tables are global
 * (secured with `grid_secure_platform_table`, writable only under the platform
 * role) and the one read that touches tenant data — the unprocessed-down-vote
 * scan over `answer_feedback` — deliberately crosses organizations, because a
 * platform lesson is distilled from everyone's reports at once. Callers state
 * that scope: every entry point into this module sits behind
 * `withPlatformAccess` in the service, and the service's own callers hold
 * either the internal token or a `platform:*` permission.
 *
 * List queries are always bounded.
 */

import 'server-only'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  platformLessonEvents,
  platformLessonReports,
  platformLessons,
  type NewPlatformLessonEvent,
  type PlatformLesson,
  type PlatformLessonEvent,
  type PlatformLessonReport,
} from '@/lib/db/schema'
import { normalizeContentGerman } from '@/lib/knowledge/consolidation'

/** Hard ceilings on every dashboard list. */
export const LESSON_LIST_LIMIT = 200
export const LESSON_EVENT_LIST_LIMIT = 200
export const LESSON_REPORT_LIST_LIMIT = 200

/**
 * How far back the sweep looks for unprocessed down-votes. Older reports are
 * left alone: a failure nobody re-reported in a month is not worth an LLM call,
 * and an unbounded backlog scan would grow with the table.
 */
export const SWEEP_WINDOW_DAYS = 30

/** One down-vote the pipeline has not processed yet, with its turn context. */
export interface UnprocessedDownvote {
  feedbackId: string
  organizationId: string
  reason: string | null
  comment: string | null
  /** The user turn preceding the voted answer, when it survives the join. */
  question: string | null
  /** The voted answer's text, when its message row was persisted. */
  answer: string | null
  createdAt: Date
}

/**
 * Down-votes with no `platform_lesson_reports` row yet, oldest first so the
 * backlog drains in arrival order. The joins mirror `listFeedbackTurns`
 * (lib/feedback/repository.ts): LEFT throughout, because a vote whose turn was
 * never persisted is still a report — reason and comment alone can carry the
 * signal.
 */
export async function listUnprocessedDownvotes(limit: number): Promise<UnprocessedDownvote[]> {
  const db = getDb()
  const result = await db.execute(sql`
    select
      f.id          as feedback_id,
      f.organization_id,
      f.reason,
      f.comment,
      f.created_at,
      m.content     as answer,
      q.content     as question
    from answer_feedback f
    left join platform_lesson_reports r on r.feedback_id = f.id
    left join messages m on m.id::text = f.message_id
    left join lateral (
      select content
      from messages
      where conversation_id = f.conversation_id
        and role = 'user'
        and (m.created_at is null or created_at <= m.created_at)
      order by created_at desc
      limit 1
    ) q on true
    where f.verdict = 'down'
      and r.id is null
      and f.created_at >= now() - make_interval(days => ${SWEEP_WINDOW_DAYS})
    order by f.created_at asc
    limit ${limit}
  `)

  const rows = (result as { rows?: Record<string, unknown>[] })?.rows ?? []
  return rows.map((row) => ({
    feedbackId: String(row.feedback_id),
    organizationId: String(row.organization_id),
    reason: (row.reason as string | null) ?? null,
    comment: (row.comment as string | null) ?? null,
    question: (row.question as string | null) ?? null,
    answer: (row.answer as string | null) ?? null,
    // Raw `sql` results are not runtime-validated — coerce at this boundary.
    createdAt: new Date(row.created_at as string),
  }))
}

/** Every lesson, newest signal first, for the dashboard. Bounded. */
export async function listLessons(): Promise<PlatformLesson[]> {
  const db = getDb()
  return db
    .select()
    .from(platformLessons)
    .orderBy(desc(platformLessons.lastReportedAt))
    .limit(LESSON_LIST_LIMIT)
}

export async function getLesson(lessonId: string): Promise<PlatformLesson | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(platformLessons)
    .where(eq(platformLessons.id, lessonId))
    .limit(1)
  return row ?? null
}

/**
 * The lessons the matcher compares a new report against: everything not
 * retired, so a report matching a held-back candidate strengthens that
 * candidate instead of spawning a duplicate.
 *
 * Most-reported first, then freshest. Failure classes follow a power law, so
 * when the live register outgrows the matcher window the lessons that fall off
 * the end are the long-tail singletons — the ones a new report is least likely
 * to duplicate. (Past that window the designed successor is embedding recall
 * through the backend's vector store; see the architecture doc's scaling
 * section.)
 */
export async function listLiveLessons(limit: number): Promise<PlatformLesson[]> {
  const db = getDb()
  return db
    .select()
    .from(platformLessons)
    .where(ne(platformLessons.status, 'retired'))
    .orderBy(desc(platformLessons.reportCount), desc(platformLessons.lastReportedAt))
    .limit(limit)
}

/** Active lessons in injection order: widest reach first, then most reported. */
export async function listActiveLessonsForDigest(limit: number): Promise<PlatformLesson[]> {
  const db = getDb()
  return db
    .select()
    .from(platformLessons)
    .where(eq(platformLessons.status, 'active'))
    .orderBy(
      desc(platformLessons.orgCount),
      desc(platformLessons.reportCount),
      desc(platformLessons.lastReportedAt)
    )
    .limit(limit)
}

/** Exact-duplicate check against the live register (JS twin of the 0068 index). */
export async function findLiveLessonByContent(content: string): Promise<PlatformLesson | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(platformLessons)
    .where(
      and(
        ne(platformLessons.status, 'retired'),
        sql`btrim(regexp_replace(lower(${platformLessons.content}), '[^a-z0-9äöüß]+', ' ', 'g')) = ${normalizeContentGerman(content)}`
      )
    )
    .limit(1)
  return row ?? null
}

export async function listLessonEvents(lessonId: string): Promise<PlatformLessonEvent[]> {
  const db = getDb()
  return db
    .select()
    .from(platformLessonEvents)
    .where(eq(platformLessonEvents.lessonId, lessonId))
    .orderBy(asc(platformLessonEvents.createdAt))
    .limit(LESSON_EVENT_LIST_LIMIT)
}

export async function listLessonReports(lessonId: string): Promise<PlatformLessonReport[]> {
  const db = getDb()
  return db
    .select()
    .from(platformLessonReports)
    .where(eq(platformLessonReports.lessonId, lessonId))
    .orderBy(desc(platformLessonReports.createdAt))
    .limit(LESSON_REPORT_LIST_LIMIT)
}

interface ReportProvenance {
  feedbackId: string
  orgHash: string
  reason: string | null
  canonicalSummary: string | null
}

/**
 * Create a lesson from its first report — lesson, provenance row and 'created'
 * event in ONE transaction, so the register can never hold a lesson whose
 * provenance chain is missing its first link.
 *
 * Returns null when the report was already processed by a concurrent sweep
 * (the UNIQUE(feedback_id) backstop fired) — the caller treats that as "done".
 */
export async function createLessonFromReport(values: {
  content: string
  category: PlatformLesson['category']
  status: PlatformLesson['status']
  heldReason: string | null
  activatedBy: string | null
  report: ReportProvenance
  actor: string
}): Promise<PlatformLesson | null> {
  const db = getDb()
  try {
    return await db.transaction(async (tx) => {
      const now = new Date()
      const [lesson] = await tx
        .insert(platformLessons)
        .values({
          content: values.content,
          category: values.category,
          status: values.status,
          heldReason: values.heldReason,
          activatedAt: values.status === 'active' ? now : null,
          activatedBy: values.status === 'active' ? values.activatedBy : null,
        })
        .returning()
      await tx.insert(platformLessonReports).values({
        feedbackId: values.report.feedbackId,
        lessonId: lesson.id,
        outcome: 'created',
        orgHash: values.report.orgHash,
        reason: values.report.reason,
        canonicalSummary: values.report.canonicalSummary,
      })
      const events: NewPlatformLessonEvent[] = [
        {
          lessonId: lesson.id,
          action: 'created',
          actor: values.actor,
          detail: { category: values.category, feedbackId: values.report.feedbackId },
        },
      ]
      if (values.status === 'active') {
        events.push({
          lessonId: lesson.id,
          action: 'activated',
          actor: values.actor,
          detail: { automatic: true },
        })
      }
      await tx.insert(platformLessonEvents).values(events)
      return lesson
    })
  } catch (err) {
    // Race backstops: a concurrent sweep processed the same feedback row
    // (reports UNIQUE) or distilled the same normalized content (0068 partial
    // unique index). Either way the work is done; the caller re-reads.
    if ((err as { code?: string } | null)?.code === '23505') return null
    throw err
  }
}

/**
 * Attach one more report to an existing lesson: provenance row, counter
 * bump (recomputed from the provenance rows, never incremented blindly) and
 * 'report_linked' event in one transaction. Returns false when the report was
 * already processed concurrently.
 */
export async function linkReportToLesson(
  lessonId: string,
  report: ReportProvenance,
  actor: string
): Promise<boolean> {
  const db = getDb()
  try {
    await db.transaction(async (tx) => {
      await tx.insert(platformLessonReports).values({
        feedbackId: report.feedbackId,
        lessonId,
        outcome: 'linked',
        orgHash: report.orgHash,
        reason: report.reason,
        canonicalSummary: report.canonicalSummary,
      })
      // Recompute from the provenance rows: an increment would drift on any
      // retried transaction, and the count IS the audit claim.
      await tx
        .update(platformLessons)
        .set({
          reportCount: sql`(select count(*)::int from ${platformLessonReports} where ${platformLessonReports.lessonId} = ${lessonId} and ${platformLessonReports.outcome} <> 'skipped')`,
          orgCount: sql`(select count(distinct ${platformLessonReports.orgHash})::int from ${platformLessonReports} where ${platformLessonReports.lessonId} = ${lessonId} and ${platformLessonReports.outcome} <> 'skipped')`,
          lastReportedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(platformLessons.id, lessonId))
      await tx.insert(platformLessonEvents).values({
        lessonId,
        action: 'report_linked',
        actor,
        detail: { feedbackId: report.feedbackId },
      })
    })
    return true
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '23505') return false
    throw err
  }
}

/** Record a report the pipeline deliberately did not turn into a lesson. */
export async function recordSkippedReport(values: {
  feedbackId: string
  orgHash: string
  reason: string | null
  skipReason: string
  canonicalSummary: string | null
}): Promise<void> {
  const db = getDb()
  try {
    await db.insert(platformLessonReports).values({
      feedbackId: values.feedbackId,
      lessonId: null,
      outcome: 'skipped',
      skipReason: values.skipReason,
      orgHash: values.orgHash,
      reason: values.reason,
      canonicalSummary: values.canonicalSummary,
    })
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '23505') return
    throw err
  }
}

/**
 * A status/content/root-cause mutation plus its event, in one transaction.
 * `patch` is what changes; `event` is how the trail explains it.
 */
export async function updateLessonWithEvent(
  lessonId: string,
  patch: Partial<
    Pick<
      PlatformLesson,
      | 'status'
      | 'content'
      | 'heldReason'
      | 'activatedAt'
      | 'activatedBy'
      | 'retiredAt'
      | 'retiredBy'
      | 'retiredReason'
      | 'rootCauseStatus'
      | 'rootCauseNote'
    >
  >,
  event: Omit<NewPlatformLessonEvent, 'lessonId'>
): Promise<PlatformLesson | null> {
  const db = getDb()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(platformLessons)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(platformLessons.id, lessonId))
      .returning()
    if (!row) return null
    await tx.insert(platformLessonEvents).values({ ...event, lessonId })
    return row
  })
}

/**
 * Retire stale or over-cap CANDIDATES (each with its own event); returns the
 * retired ids.
 *
 * Candidates are the register's growth risk: an auditor-flagged singleton
 * nobody reviews would otherwise sit "held" forever, and enough of them crowd
 * the bounded matcher window until new reports stop matching and spawn MORE
 * duplicate candidates — a divergence loop. So a candidate earns its slot the
 * same way an active lesson does: by being re-reported. Not re-reported within
 * `maxAgeDays`, or beyond `maxCandidates` (most-reported, then freshest,
 * survive) → retired as 'candidate_expired'. Retirement is reversible in the
 * dashboard and fully evented, so nothing is lost — only de-prioritized.
 */
export async function expireStaleCandidates(
  maxAgeDays: number,
  maxCandidates: number,
  actor: string
): Promise<string[]> {
  const db = getDb()
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: platformLessons.id, lastReportedAt: platformLessons.lastReportedAt })
      .from(platformLessons)
      .where(eq(platformLessons.status, 'candidate'))
      .orderBy(desc(platformLessons.reportCount), desc(platformLessons.lastReportedAt))
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const expired = new Set<string>()
    for (const candidate of candidates.slice(maxCandidates)) expired.add(candidate.id)
    for (const candidate of candidates) {
      if (candidate.lastReportedAt.getTime() < cutoff) expired.add(candidate.id)
    }
    const ids = [...expired]
    if (ids.length === 0) return []
    const now = new Date()
    await tx
      .update(platformLessons)
      .set({
        status: 'retired',
        retiredAt: now,
        retiredBy: actor,
        retiredReason: 'candidate_expired',
        updatedAt: now,
      })
      .where(inArray(platformLessons.id, ids))
    await tx.insert(platformLessonEvents).values(
      ids.map((id) => ({
        lessonId: id,
        action: 'retired' as const,
        actor,
        detail: { reason: 'candidate_expired' },
      }))
    )
    return ids
  })
}

/**
 * Retire the least-recently-reported active lessons beyond `maxActive`
 * (capacity eviction, each with its own event). Returns the ids retired.
 */
export async function evictActiveOverCapacity(maxActive: number, actor: string): Promise<string[]> {
  const db = getDb()
  return db.transaction(async (tx) => {
    const active = await tx
      .select({ id: platformLessons.id })
      .from(platformLessons)
      .where(eq(platformLessons.status, 'active'))
      .orderBy(desc(platformLessons.lastReportedAt), desc(platformLessons.reportCount))
    const excess = active.slice(maxActive).map((row) => row.id)
    if (excess.length === 0) return []
    const now = new Date()
    await tx
      .update(platformLessons)
      .set({
        status: 'retired',
        retiredAt: now,
        retiredBy: actor,
        retiredReason: 'evicted_capacity',
        updatedAt: now,
      })
      .where(inArray(platformLessons.id, excess))
    await tx.insert(platformLessonEvents).values(
      excess.map((id) => ({
        lessonId: id,
        action: 'retired' as const,
        actor,
        detail: { reason: 'evicted_capacity' },
      }))
    )
    return excess
  })
}

/** Counts for the dashboard header (candidates awaiting review, active, retired). */
export async function countLessonsByStatus(): Promise<Record<string, number>> {
  const db = getDb()
  const rows = await db
    .select({ status: platformLessons.status, count: sql<string>`count(*)` })
    .from(platformLessons)
    .groupBy(platformLessons.status)
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]))
}
