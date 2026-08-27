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
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
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
import { cosineSimilaritySql, toVectorLiteral } from '@/lib/knowledge/embeddings'

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

/**
 * Cosine above which a report is treated as restating an existing lesson.
 *
 * Lower than memory's 0.90 on purpose: two lesson texts are already
 * generalized process cautions, so near-neighbours in that space really are
 * the same failure class ("check which guideline applies before citing" vs
 * "verify the referenced guideline matches the question"). Still calibrated
 * toward separation — a wrong merge buries a distinct failure mode.
 */
export const LESSON_SEMANTIC_MATCH_THRESHOLD = 0.85

/**
 * The lessons a report most plausibly restates, by SEMANTIC similarity.
 *
 * This is what the top-N rank window was standing in for. A window ordered by
 * report count answers "which lessons are popular", not "which lesson is this
 * report about" — and past the window the matcher simply could not see the
 * lesson it should have merged into, so the register grew a near-duplicate
 * and the two then split future reports between them.
 *
 * Returns [] when nothing is embedded or the embedder was unavailable, which
 * the caller reads as "fall back to the rank window".
 */
export async function listSemanticLessonCandidates(
  vector: number[],
  fingerprint: string,
  limit: number
): Promise<PlatformLesson[]> {
  const db = getDb()
  const rows = await db
    .select({
      lesson: platformLessons,
      similarity: cosineSimilaritySql(platformLessons.embedding, vector),
    })
    .from(platformLessons)
    .where(
      and(
        ne(platformLessons.status, 'retired'),
        // Never compare across embedding models — same length, different space.
        eq(platformLessons.embeddingModel, fingerprint),
        sql`grid_cosine_similarity(${platformLessons.embedding}, ${toVectorLiteral(vector)}::real[]) >= ${LESSON_SEMANTIC_MATCH_THRESHOLD}`
      )
    )
    .orderBy(desc(cosineSimilaritySql(platformLessons.embedding, vector)))
    .limit(limit)
  return rows.map((row) => row.lesson)
}

/** Store a lesson's vector after the fact (backfill / re-embed on model change). */
export async function setLessonEmbedding(
  lessonId: string,
  vector: number[],
  fingerprint: string
): Promise<void> {
  await getDb()
    .update(platformLessons)
    .set({ embedding: vector, embeddingModel: fingerprint, embeddedAt: new Date() })
    .where(eq(platformLessons.id, lessonId))
}

/** Lessons still missing a usable vector, oldest first. Bounded. */
export async function listLessonsMissingEmbedding(
  fingerprint: string,
  limit: number
): Promise<PlatformLesson[]> {
  const db = getDb()
  return db
    .select()
    .from(platformLessons)
    .where(
      and(
        ne(platformLessons.status, 'retired'),
        or(
          isNull(platformLessons.embedding),
          ne(platformLessons.embeddingModel, fingerprint)
        )
      )
    )
    .orderBy(asc(platformLessons.createdAt))
    .limit(limit)
}

/**
 * Recompute both vote counters for every ACTIVE lesson from `answer_feedback`.
 *
 * Exposure is a function of time here — with an always-injected digest, a vote
 * at T saw every lesson active at T — so this is a temporal join and needs no
 * per-turn exposure table. Two honest caveats, both documented on the schema:
 * it is a CORRELATION (every active lesson is credited for every vote in its
 * window), and the digest caches mean a lesson activated minutes ago may not
 * have reached every worker yet. Votes from the holdout arm are excluded:
 * those turns saw no lessons at all, so counting them would credit a lesson
 * for answers it demonstrably did not touch.
 */
export async function recomputeLessonVoteCounters(): Promise<void> {
  await getDb().execute(sql`
    update platform_lessons l
    set helpful_votes = counts.up,
        harmful_votes = counts.down
    from (
      select
        l2.id,
        count(*) filter (where f.verdict = 'up')   as up,
        count(*) filter (where f.verdict = 'down') as down
      from platform_lessons l2
      left join answer_feedback f
        on f.created_at >= l2.activated_at
       and (l2.retired_at is null or f.created_at <= l2.retired_at)
       and coalesce(f.lessons_holdout, false) = false
      where l2.status = 'active' and l2.activated_at is not null
      group by l2.id
    ) counts
    where l.id = counts.id
      and (l.helpful_votes is distinct from counts.up
        or l.harmful_votes is distinct from counts.down)
  `)
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
  /** Vector for the lesson text, when the embedder was reachable. */
  embedding?: { vector: number[]; fingerprint: string } | null
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
          ...(values.embedding
            ? {
                embedding: values.embedding.vector,
                embeddingModel: values.embedding.fingerprint,
                embeddedAt: now,
              }
            : {}),
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

/**
 * Let a re-voted report be distilled again — but only when the first pass
 * produced nothing.
 *
 * A user who down-votes, then comes back and writes what was actually wrong,
 * has supplied strictly more signal than the bare thumb the sweep already
 * dismissed. The UNIQUE(feedback_id) provenance row is what stops the sweep
 * from ever looking at it again, so a re-vote clears exactly that row.
 *
 * Deliberately limited to `outcome = 'skipped'`. A report that CREATED or was
 * LINKED to a lesson keeps its row forever: the lesson exists, its evidence
 * chain has to keep pointing at this report, and re-distilling it would count
 * one user's opinion twice in `report_count` — which is the number the
 * activation and eviction order are built on.
 *
 * Returns true when a row was actually cleared, so the caller only kicks the
 * pipeline when there is new work.
 */
export async function reopenSkippedReport(feedbackId: string): Promise<boolean> {
  const cleared = await getDb()
    .delete(platformLessonReports)
    .where(
      and(
        eq(platformLessonReports.feedbackId, feedbackId),
        eq(platformLessonReports.outcome, 'skipped')
      )
    )
    .returning({ id: platformLessonReports.id })
  return cleared.length > 0
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
