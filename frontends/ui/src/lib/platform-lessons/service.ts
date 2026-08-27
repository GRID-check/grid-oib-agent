/**
 * Platform-lessons service — the automatic learning loop behind
 * Platform → Lessons (docs/architecture/platform-failure-learning.md).
 *
 * The doctrine this productizes is the repo's own correction ratchet
 * (docs/contributing/correction-ratchet.md): a down-vote is a human stepping
 * in, and the first one is already the signal. The pipeline turns each
 * down-vote into an anonymized, deduplicated lesson and injects the active set
 * into every agent turn — so a failure class a user reported once does not
 * need a second reporter. Every step lands in the append-only event trail, and
 * the dashboard presents the whole register as what it is: a SYMPTOMATIC
 * bandage that holds while the root cause is still open.
 *
 * Anonymization is layered, none of the layers trusted alone:
 *  1. deterministic PII scrub before anything leaves this tier (redactPii),
 *  2. the distiller prompt writes the failure CLASS, never the instance,
 *  3. an auditor model screens the distilled text — a flagged lesson is held
 *     as 'candidate' for a human instead of activating,
 *  4. provenance is stored by reference (feedback uuid + sha256 org hash);
 *     dereferencing back to the raw report is an audited platform-bypass read.
 *
 * Concurrency: two replicas can sweep at once. Correctness is guarded by the
 * UNIQUE(feedback_id) provenance key and the normalized-content lesson index —
 * the worst a race costs is one duplicate LLM call, which is why there is no
 * cross-replica lock held across model calls.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import { requirePlatformPermission } from '@/lib/authz/platform'
import { getPlatformOrganizationId } from '@/lib/authz/platform'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { recordAuditEvent } from '@/lib/audit/service'
import type { GridSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { getCached, invalidateCached } from '@/lib/cache'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import type { PlatformLesson, PlatformLessonEvent, PlatformLessonReport } from '@/lib/db/schema'
import { formatBoundedDigest } from '@/lib/knowledge/digest-format'
import { redactPii } from '@/lib/text/redact-pii'
import { distillReport } from './distill-client'
import { embedNote, embedNotes, enrichForEmbedding } from '@/lib/knowledge/embeddings'
import {
  countLessonsByStatus,
  createLessonFromReport,
  evictActiveOverCapacity,
  expireStaleCandidates,
  flagIneffectiveActiveLessons,
  findLiveLessonByContent,
  getLesson,
  linkReportToLesson,
  listActiveLessonsForDigest,
  listLessonEvents,
  listLessonReports,
  listLessons,
  listLessonsMissingEmbedding,
  listLiveLessons,
  listSemanticLessonCandidates,
  listUnprocessedDownvotes,
  recomputeLessonVoteCounters,
  recordSkippedReport,
  reopenSkippedReport,
  retireQuietAddressedLessons,
  setLessonEmbedding,
  updateLessonWithEvent,
} from './repository'
import {
  MAX_DISTILL_ANSWER_CHARS,
  MAX_DISTILL_COMMENT_CHARS,
  MAX_DISTILL_QUESTION_CHARS,
  MAX_DISTILL_REGISTER_SIZE,
  toLessonView,
  type PlatformLessonView,
  type UpdateLessonInput,
} from './types'

/**
 * The active register is capped, and the cap is a PROMPT budget, not a storage
 * one: every active lesson rides every turn of every tenant. Past the cap the
 * least-recently-reported lesson is auto-retired ('evicted_capacity') — a
 * failure class nobody has hit in a while has earned its slot back.
 */
export const MAX_ACTIVE_LESSONS = 20
/** Character budget of the injected digest (compare: memory digest 1800). */
export const DIGEST_MAX_CHARS = 1600

/**
 * Candidates expire like anything else that must not grow without bound: not
 * re-reported within the age window, or beyond the cap, they are auto-retired
 * ('candidate_expired', reversible in the dashboard). Without this, flagged
 * singletons accumulate forever and crowd the bounded matcher window until new
 * reports stop matching and spawn more duplicates.
 */
export const CANDIDATE_MAX_AGE_DAYS = 45
export const MAX_HELD_CANDIDATES = 40

/**
 * Linked reports since activation at which a lesson is flagged as not holding
 * ('flagged_ineffective', once per activation). One recurrence can be one
 * stubborn user re-reporting; three distinct reports the matcher tied to the
 * same active lesson is the failure class demonstrably surviving treatment.
 */
export const LESSON_RECURRENCE_FLAG_THRESHOLD = 3
/**
 * Days a root-cause-'addressed' lesson must stay recurrence-free before the
 * sweep retires it automatically. Two weeks is enough turns for a recurring
 * failure class to resurface (the median relink gap in the register is days,
 * not weeks), short enough that a healed wound's bandage does not spend the
 * quarter riding every prompt.
 */
export const LESSON_ADDRESSED_QUIET_DAYS = 14

/**
 * Reports processed per event-driven kick, per manual sweep, and the ceiling a
 * kick may rise to when a backlog has formed.
 *
 * The kick normally does a little work per vote, which is enough to keep pace:
 * one down-vote arrives, up to three are distilled. A backlog only forms while
 * the distiller is unavailable, and then a fixed three-per-kick would drain it
 * at the rate people happen to vote — so the kick reads how much is waiting
 * (the sweep already over-fetches) and widens up to `KICK_BACKLOG_LIMIT`.
 *
 * This is why there is no scheduler container: the work is event-driven and
 * self-healing while anyone is voting, and a deployment where nobody votes is
 * also a deployment where no backlog forms. An operator who wants a clock can
 * point one at `POST /api/internal/platform-lessons/sweep`.
 */
const KICK_SWEEP_LIMIT = 3
const KICK_BACKLOG_LIMIT = 12
/** Waiting reports above which a kick widens toward `KICK_BACKLOG_LIMIT`. */
const BACKLOG_WIDEN_THRESHOLD = 10
const MANUAL_SWEEP_LIMIT = 25

/**
 * A report is retried at most this often per process. Deferral (a distiller
 * error) leaves no row on purpose — the next sweep retries — but oldest-first
 * ordering then means a PERMANENTLY failing report would sit at the head of
 * every sweep and wedge the pipeline behind it. The memo is deliberately
 * in-process (resets on deploy, which is exactly when a permanent failure is
 * most likely to have been fixed); the 30-day sweep window is the durable
 * backstop.
 */
const MAX_ATTEMPTS_PER_PROCESS = 3
const ATTEMPT_MEMO_CAP = 512
const distillAttempts = new Map<string, number>()

/**
 * One sweep at a time per process. Kicks arrive per down-vote, so a burst
 * would otherwise start N concurrent sweeps that all pick the same oldest
 * reports and all pay the same LLM calls — the UNIQUE backstop keeps that
 * correct but not cheap. Cross-replica duplicates remain possible and bounded
 * by replica count; that residual is accepted rather than serialized through a
 * lock held across model calls.
 */
let sweepInFlight: Promise<SweepResult> | null = null

/** Test hook: clear the per-process sweep state. */
export function resetLessonSweepStateForTests(): void {
  distillAttempts.clear()
  sweepInFlight = null
  fingerprintProbe = null
}

const DIGEST_CACHE_KEY = 'platformlessons:digest:v1'
const DIGEST_CACHE_TTL_MS = 5 * 60 * 1000

const SYSTEM_ACTOR = 'system:distiller'

/** Pseudonymous org identity — enough to count distinct orgs, nothing more. */
function orgHash(organizationId: string): string {
  return createHash('sha256').update(organizationId).digest('hex')
}

/** Scrub + collapse + truncate one free-text input for the distiller. */
function prepare(text: string | null, maxChars: number): string | null {
  if (!text) return null
  const flat = redactPii(text).replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat
}

/** Lessons re-embedded per sweep. Small: the next sweep continues. */
const LESSON_BACKFILL_BATCH = 8

/**
 * Embed lessons whose vector is missing or from a retired embedding model.
 *
 * The fingerprint of the CURRENT model is only knowable by embedding
 * something, so the first result's fingerprint drives the missing-rows query —
 * one probe, then the batch.
 */
let fingerprintProbe: { fingerprint: string; at: number } | null = null
const FINGERPRINT_PROBE_TTL_MS = 10 * 60 * 1000

async function backfillLessonEmbeddings(): Promise<void> {
  // The current model's fingerprint, memoized: it changes only on a config
  // change, and paying an embedding call per sweep to re-learn a constant
  // would be the pipeline's only fixed cost with zero work to do.
  if (!fingerprintProbe || Date.now() - fingerprintProbe.at > FINGERPRINT_PROBE_TTL_MS) {
    const probe = await embedNote('fingerprint probe')
    if (!probe) return
    fingerprintProbe = { fingerprint: probe.fingerprint, at: Date.now() }
  }
  const probe = fingerprintProbe
  const missing = await listLessonsMissingEmbedding(probe.fingerprint, LESSON_BACKFILL_BATCH)
  if (missing.length === 0) return
  const embedded = await embedNotes(
    missing.map((lesson) => enrichForEmbedding(lesson.content, [lesson.category]))
  )
  if (!embedded) return
  for (let index = 0; index < missing.length; index++) {
    await setLessonEmbedding(missing[index].id, embedded[index].vector, embedded[index].fingerprint)
  }
}

export interface SweepResult {
  processed: number
  created: number
  linked: number
  skipped: number
  /** Reports left for a later sweep because the distiller errored. */
  deferred: number
}

/**
 * Process up to `limit` unprocessed down-votes. The single code path for both
 * the event-driven kick (a down-vote just arrived) and the manual catch-up
 * button — one path means the two can never disagree about the rules.
 */
async function sweep(limit: number): Promise<SweepResult> {
  const result: SweepResult = { processed: 0, created: 0, linked: 0, skipped: 0, deferred: 0 }

  // Register hygiene first, every sweep: cheap (two indexed reads over
  // candidates), and skipping it is how the candidate pile would out-grow the
  // matcher window between manual visits to the dashboard.
  await expireStaleCandidates(CANDIDATE_MAX_AGE_DAYS, MAX_HELD_CANDIDATES, SYSTEM_ACTOR)

  // Refresh the vote correlation while we are here. Cheap (one indexed
  // aggregate over the active set) and it keeps the dashboard's numbers from
  // depending on somebody opening the dashboard.
  await recomputeLessonVoteCounters().catch((error: unknown) => {
    console.warn('[PlatformLessons] Vote counter refresh failed (non-fatal):', error)
  })

  // Effectiveness, per lesson, from the one signal that can indict one lesson:
  // recurrence. A report the matcher LINKS to an already-active lesson means
  // the failure recurred under treatment — at the threshold the lesson is
  // flagged (it stays active; the flag routes a human at the root cause). The
  // mirror rule closes the other end of the lifecycle: root cause addressed
  // plus a quiet period with zero recurrences retires the bandage without a
  // person having to remember to.
  await flagIneffectiveActiveLessons(LESSON_RECURRENCE_FLAG_THRESHOLD, SYSTEM_ACTOR).catch(
    (error: unknown) => {
      console.warn('[PlatformLessons] Ineffectiveness flagging failed (non-fatal):', error)
    }
  )
  await retireQuietAddressedLessons(LESSON_ADDRESSED_QUIET_DAYS, SYSTEM_ACTOR)
    .then(async (ids) => {
      if (ids.length > 0) await invalidateCached(DIGEST_CACHE_KEY)
    })
    .catch((error: unknown) => {
      console.warn('[PlatformLessons] Quiet-addressed retirement failed (non-fatal):', error)
    })

  // Embedding backfill, same rhythm: lessons written while the embedder was
  // down — or before an embedding-model change — fall back to the popularity
  // window until something re-embeds them. Each sweep heals a bounded batch,
  // so the register converges without a dedicated job.
  await backfillLessonEmbeddings().catch((error: unknown) => {
    console.warn('[PlatformLessons] Embedding backfill failed (non-fatal):', error)
  })

  // Over-fetch, then drop reports this process has already failed on
  // repeatedly — otherwise a permanently failing report at the oldest-first
  // head is re-fetched by every sweep and wedges everything behind it.
  // Over-fetch: it both skips reports this process keeps failing on and tells
  // us how deep the backlog is, which is what lets a kick widen after an
  // outage instead of draining three per vote forever.
  const fetched = await listUnprocessedDownvotes(Math.max(limit, KICK_BACKLOG_LIMIT) * 2)
  const eligible = fetched.filter(
    (report) => (distillAttempts.get(report.feedbackId) ?? 0) < MAX_ATTEMPTS_PER_PROCESS
  )
  const effectiveLimit =
    limit === KICK_SWEEP_LIMIT && eligible.length > BACKLOG_WIDEN_THRESHOLD
      ? KICK_BACKLOG_LIMIT
      : limit
  const pending = eligible.slice(0, effectiveLimit)

  for (const report of pending) {
    result.processed++
    const provenance = {
      feedbackId: report.feedbackId,
      orgHash: orgHash(report.organizationId),
      reason: report.reason,
    }

    const question = prepare(report.question, MAX_DISTILL_QUESTION_CHARS)
    const answer = prepare(report.answer, MAX_DISTILL_ANSWER_CHARS)
    const comment = prepare(report.comment, MAX_DISTILL_COMMENT_CHARS)

    // A bare thumb with no reason, no comment and no recoverable turn carries
    // nothing to distill — recorded as processed so the sweep never re-reads it.
    if (!comment && !question && !answer && !report.reason) {
      await recordSkippedReport({ ...provenance, skipReason: 'no_signal', canonicalSummary: null })
      result.skipped++
      continue
    }

    // The register the matcher compares against. Semantic first: candidates
    // that are actually ABOUT the same failure, wherever they sit in the
    // register. The rank window survives only as the fallback for an
    // unembedded register or an unavailable embedder — it answers "which
    // lessons are popular", which is a different question.
    const reportVector = await embedNote(
      enrichForEmbedding([comment, question].filter(Boolean).join(' '), [report.reason ?? 'other'])
    )
    const semantic = reportVector
      ? await listSemanticLessonCandidates(
          reportVector.vector,
          reportVector.fingerprint,
          MAX_DISTILL_REGISTER_SIZE
        )
      : []
    // UNION, not either/or: the semantic set answers "what is this report
    // about", the popular set covers the failure classes reported so often
    // that missing one would be embarrassing even when the embedding is off
    // in space. Deduped by id, semantic first, bounded as one register.
    const popular = await listLiveLessons(
      semantic.length > 0 ? 10 : MAX_DISTILL_REGISTER_SIZE
    )
    const seen = new Set(semantic.map((lesson) => lesson.id))
    const register = [
      ...semantic,
      ...popular.filter((lesson) => !seen.has(lesson.id)),
    ].slice(0, MAX_DISTILL_REGISTER_SIZE)
    const outcome = await distillReport({
      question,
      answer,
      reason: report.reason,
      comment,
      existingLessons: register.map((lesson) => ({ id: lesson.id, content: lesson.content })),
    })

    if (outcome.error) {
      // Deliberately NOT recorded in the DB: an unprocessed report is retried
      // by the next sweep, a mis-recorded one is lost. The in-process memo is
      // what stops the retrying from wedging the queue's head.
      if (distillAttempts.size >= ATTEMPT_MEMO_CAP) distillAttempts.clear()
      distillAttempts.set(report.feedbackId, (distillAttempts.get(report.feedbackId) ?? 0) + 1)
      result.deferred++
      continue
    }

    const summary = { ...provenance, canonicalSummary: outcome.canonicalSummary }

    if (outcome.matchLessonId) {
      const linked = await linkReportToLesson(outcome.matchLessonId, summary, SYSTEM_ACTOR)
      if (linked) {
        result.linked++
        await invalidateCached(DIGEST_CACHE_KEY)
      }
      continue
    }

    if (!outcome.generalizable || !outcome.lesson) {
      await recordSkippedReport({
        ...summary,
        skipReason: outcome.generalizable ? 'no_lesson' : 'not_generalizable',
      })
      result.skipped++
      continue
    }

    // Exact-duplicate backstop before creating: the matcher is a model and can
    // miss a restatement the normalizer catches.
    const exact = await findLiveLessonByContent(outcome.lesson)
    if (exact) {
      const linked = await linkReportToLesson(exact.id, summary, SYSTEM_ACTOR)
      if (linked) result.linked++
      continue
    }

    // The automatic activation gate: generalizable AND clean-audited lessons go
    // live immediately — "a failure should never occur twice" — while anything
    // the auditor flagged waits as a candidate for a human decision. That gate
    // placement (activation, not distillation) is what keeps the loop automatic
    // AND supervised.
    // Embed the lesson TEXT (not the report) for future matching — one call,
    // stored with the row, so the next report can find this lesson by meaning.
    const lessonVector = await embedNote(
      enrichForEmbedding(outcome.lesson, [outcome.category])
    )

    const created = await createLessonFromReport({
      embedding: lessonVector,
      content: outcome.lesson,
      category: outcome.category,
      status: outcome.auditPassed ? 'active' : 'candidate',
      heldReason: outcome.auditPassed ? null : 'audit_flagged',
      activatedBy: outcome.auditPassed ? SYSTEM_ACTOR : null,
      report: summary,
      actor: SYSTEM_ACTOR,
    })
    if (created) {
      result.created++
      if (created.status === 'active') {
        await evictActiveOverCapacity(MAX_ACTIVE_LESSONS, SYSTEM_ACTOR)
        await invalidateCached(DIGEST_CACHE_KEY)
      }
    }
  }

  return result
}

/**
 * Fire-and-forget kick after a down-vote lands (`next/server`'s `after` in the
 * feedback route). Never throws — a broken pipeline must not be able to break
 * voting, and anything it leaves behind is picked up by the next kick or the
 * manual sweep.
 */
export async function kickLessonDistillation(): Promise<void> {
  // A kick that finds a sweep already running has nothing to add: the running
  // sweep (or the next one) will pick the new report up, and joining it would
  // only race the same oldest-first head.
  if (sweepInFlight) return
  try {
    sweepInFlight = withPlatformAccess('platform lessons: distill new answer feedback', () =>
      sweep(KICK_SWEEP_LIMIT)
    )
    await sweepInFlight
  } catch (error) {
    console.error('[PlatformLessons] Distillation kick failed (non-fatal):', error)
  } finally {
    sweepInFlight = null
  }
}

/**
 * A re-vote carrying new detail: clear a previous "nothing to learn here"
 * verdict so the next sweep reconsiders it. No-op when the report already
 * produced a lesson (its evidence chain must keep pointing at it, and
 * re-distilling would count one user's opinion twice).
 *
 * Never throws — voting must not depend on the pipeline being healthy.
 */
export async function reopenReportForRedistillation(feedbackId: string): Promise<boolean> {
  try {
    return await withPlatformAccess('platform lessons: reopen a re-voted report', () =>
      reopenSkippedReport(feedbackId)
    )
  } catch (error) {
    console.warn('[PlatformLessons] Could not reopen a re-voted report (non-fatal):', error)
    return false
  }
}


/**
 * The same catch-up run, for the token-guarded internal trigger (an external
 * clock). No session: the internal token IS the authorization, exactly as it
 * is for the digest route this sits beside.
 */
export async function runInternalLessonSweep(): Promise<SweepResult> {
  if (sweepInFlight) await sweepInFlight.catch(() => undefined)
  try {
    sweepInFlight = withPlatformAccess('platform lessons: scheduled sweep', () =>
      sweep(MANUAL_SWEEP_LIMIT)
    )
    return await sweepInFlight
  } finally {
    sweepInFlight = null
  }
}

/**
 * The manual catch-up run behind the dashboard's sweep button. Waits for any
 * in-flight kick rather than racing it, then runs its own (larger) pass so the
 * result it reports describes work it actually did.
 */
export async function runLessonSweep(session: GridSession | null): Promise<SweepResult> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsManage)
  if (sweepInFlight) await sweepInFlight.catch(() => undefined)
  try {
    sweepInFlight = withPlatformAccess('platform lessons: manual sweep', () =>
      sweep(MANUAL_SWEEP_LIMIT)
    )
    return await sweepInFlight
  } finally {
    sweepInFlight = null
  }
}

/**
 * The bounded digest injected into every agent turn, cached because it is
 * identical for every tenant and read once per turn per backend worker.
 * Null when no lesson is active — the agent then renders no block at all.
 */
export async function buildPlatformLessonsDigest(): Promise<string | null> {
  return getCached(DIGEST_CACHE_KEY, DIGEST_CACHE_TTL_MS, () =>
    withPlatformAccess('platform lessons: build injection digest', async () => {
      const lessons = await listActiveLessonsForDigest(MAX_ACTIVE_LESSONS)
      return formatBoundedDigest(
        'PLATFORM_LESSONS v1',
        lessons.map((lesson) => ({
          tags: [lesson.category, `${lesson.reportCount}x`],
          content: lesson.content,
        })),
        DIGEST_MAX_CHARS
      )
    })
  )
}

export interface LessonOverview {
  lessons: PlatformLessonView[]
  counts: Record<string, number>
}

/** The dashboard list. */
export async function getLessonOverview(session: GridSession | null): Promise<LessonOverview> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsView)
  return withPlatformAccess('platform lessons: dashboard list', async () => {
    const [lessons, counts] = await Promise.all([listLessons(), countLessonsByStatus()])
    return { lessons: lessons.map(toLessonView), counts }
  })
}

export interface LessonProvenance {
  lesson: PlatformLessonView
  events: {
    id: string
    action: PlatformLessonEvent['action']
    actor: string
    actorEmail: string | null
    detail: Record<string, string | number | boolean>
    createdAt: string
  }[]
  reports: {
    id: string
    feedbackId: string
    outcome: PlatformLessonReport['outcome']
    orgHash: string
    canonicalSummary: string | null
    reason: string | null
    createdAt: string
  }[]
}

/**
 * The audit drill-in: the lesson, its full event trail, and its provenance
 * rows. What this deliberately does NOT return is the raw feedback — the
 * feedback uuid is the pointer, and whoever needs the raw report follows it
 * through the quality dashboard's tenant-crossing read, which has its own gate.
 */
export async function getLessonProvenance(
  session: GridSession | null,
  lessonId: string
): Promise<LessonProvenance> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsView)
  return withPlatformAccess('platform lessons: audit trail', async () => {
    const lesson = await getLesson(lessonId)
    if (!lesson) throw new NotFoundError('Unknown lesson.')
    const [events, reports] = await Promise.all([
      listLessonEvents(lessonId),
      listLessonReports(lessonId),
    ])
    return {
      lesson: toLessonView(lesson),
      events: events.map((event) => ({
        id: event.id,
        action: event.action,
        actor: event.actor,
        actorEmail: event.actorEmail ?? null,
        detail: event.detail,
        createdAt: event.createdAt.toISOString(),
      })),
      reports: reports.map((report) => ({
        id: report.id,
        feedbackId: report.feedbackId,
        outcome: report.outcome,
        orgHash: report.orgHash,
        canonicalSummary: report.canonicalSummary ?? null,
        reason: report.reason ?? null,
        createdAt: report.createdAt.toISOString(),
      })),
    }
  })
}

/**
 * Owner mutations: activate / retire / edit / root-cause. Every change lands
 * in the event trail AND the WorkOS audit log (platform.lesson.updated), and
 * anything that alters the active set invalidates the injected digest.
 */
export async function updateLesson(
  session: GridSession | null,
  lessonId: string,
  input: UpdateLessonInput,
  requestForAudit?: Request
): Promise<PlatformLessonView> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsManage)
  const actor = session?.userId ?? 'unknown'
  const actorEmail = session?.email ?? null

  const updated = await withPlatformAccess('platform lessons: owner mutation', async () => {
    const existing = await getLesson(lessonId)
    if (!existing) throw new NotFoundError('Unknown lesson.')
    const now = new Date()
    let row: PlatformLesson | null = existing

    if (input.content !== undefined && input.content !== existing.content) {
      row = await updateLessonWithEvent(
        lessonId,
        { content: input.content },
        { action: 'edited', actor, actorEmail, detail: { previousContent: existing.content } }
      )
    }

    if (input.status === 'active' && existing.status !== 'active') {
      row = await updateLessonWithEvent(
        lessonId,
        {
          status: 'active',
          heldReason: null,
          activatedAt: now,
          activatedBy: actor,
          retiredAt: null,
          retiredBy: null,
          retiredReason: null,
        },
        {
          action: existing.status === 'retired' ? 'reactivated' : 'activated',
          actor,
          actorEmail,
          detail: { automatic: false },
        }
      )
      await evictActiveOverCapacity(MAX_ACTIVE_LESSONS, actor)
    } else if (input.status === 'retired' && existing.status !== 'retired') {
      row = await updateLessonWithEvent(
        lessonId,
        {
          status: 'retired',
          retiredAt: now,
          retiredBy: actor,
          retiredReason: input.reason ?? null,
        },
        { action: 'retired', actor, actorEmail, detail: { reason: input.reason ?? '' } }
      )
    }

    if (
      input.rootCauseStatus !== undefined ||
      input.rootCauseNote !== undefined
    ) {
      row = await updateLessonWithEvent(
        lessonId,
        {
          ...(input.rootCauseStatus !== undefined ? { rootCauseStatus: input.rootCauseStatus } : {}),
          ...(input.rootCauseNote !== undefined ? { rootCauseNote: input.rootCauseNote } : {}),
        },
        {
          action: 'root_cause_updated',
          actor,
          actorEmail,
          detail: {
            rootCauseStatus: input.rootCauseStatus ?? existing.rootCauseStatus,
          },
        }
      )
    }

    if (!row) throw new NotFoundError('Unknown lesson.')
    return row
  })

  await invalidateCached(DIGEST_CACHE_KEY)

  const platformOrgId = await getPlatformOrganizationId()
  if (platformOrgId) {
    await recordAuditEvent({
      organizationId: platformOrgId,
      actor: { userId: actor, email: actorEmail ?? undefined },
      action: 'platform.lesson.updated',
      targetType: 'platform_lesson',
      targetId: lessonId,
      metadata: {
        status: input.status ?? '',
        contentChanged: input.content !== undefined,
        rootCauseStatus: input.rootCauseStatus ?? '',
        reason: input.reason ?? '',
      },
      request: requestForAudit,
    })
  } else {
    // Same posture as the model-defaults route: the save stands (refusing a
    // curation change because the audit sink is unreachable would be worse),
    // but an unaudited fleet-visible change must not pass silently.
    console.error(
      '[PlatformLessons] Lesson was changed without a WorkOS audit event: the platform organization did not resolve'
    )
  }

  return toLessonView(updated)
}
