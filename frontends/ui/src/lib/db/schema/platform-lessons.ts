import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Platform lessons — the product's own correction ratchet
 * (docs/architecture/platform-failure-learning.md; the doctrine is
 * docs/contributing/correction-ratchet.md: "human intervention is a failure
 * signal").
 *
 * A down-vote on an answer is a human stepping in. Until now that signal ended
 * on a dashboard a person had to notice — the exact anti-pattern the repo's own
 * contributor docs name. These tables close the loop: each down-vote is
 * distilled into an anonymized, deduplicated LESSON, and the active lessons are
 * injected into every agent turn so the same failure class does not have to be
 * reported twice.
 *
 * A lesson is explicitly a SYMPTOMATIC fix — the weakest ratchet. It keeps a
 * reported failure from recurring while the root cause (a prompt, a retrieval
 * gap, a missing source) is still open; `root_cause_status` is the honest
 * marker for that, surfaced as such in Platform → Lessons.
 *
 * Global by design — no `organization_id` on any of the three tables, which is
 * both the point (one lesson reaches every tenant) and the anonymization
 * boundary: provenance is kept BY REFERENCE (the feedback row's uuid plus a
 * pseudonymous org hash for distinct-org counting), so the raw report stays
 * behind the tenant boundary in `answer_feedback` and is dereferenced only
 * under the audited platform bypass.
 *
 * Unlike the other platform tables, the tenant role holds NO read grant here
 * (0068 revokes the helper's SELECT): nothing tenant-facing queries these
 * tables — the digest is built under the platform role — and a candidate
 * lesson is exactly the text the auditor flagged as possibly identifying.
 */

/** Lesson categories — the reporter's down-vote reason keys, verbatim. */
export const PLATFORM_LESSON_CATEGORIES = ['inaccurate', 'too_slow', 'wrong_source', 'other'] as const
export type PlatformLessonCategory = (typeof PLATFORM_LESSON_CATEGORIES)[number]

/**
 * Lesson lifecycle.
 *
 *  'candidate' — distilled but not injected. The automatic gate held it back
 *                (the auditor model flagged possibly-identifying content, or
 *                the report did not generalize) and a platform owner decides.
 *  'active'    — injected into every agent turn, within the digest budget.
 *  'retired'   — no longer injected. Kept forever: the audit trail must be able
 *                to say what the fleet was told, and when that stopped.
 */
export const PLATFORM_LESSON_STATUSES = ['candidate', 'active', 'retired'] as const
export type PlatformLessonStatus = (typeof PLATFORM_LESSON_STATUSES)[number]

/**
 * Whether the failure class behind a lesson has been fixed at its source.
 * A lesson is a bandage; this is the wound's chart. 'addressed' does not retire
 * the lesson by itself — the platform owner does that once the fix is verified.
 */
export const PLATFORM_LESSON_ROOT_CAUSE_STATUSES = ['open', 'addressed'] as const
export type PlatformLessonRootCauseStatus = (typeof PLATFORM_LESSON_ROOT_CAUSE_STATUSES)[number]

/** What happened to one processed feedback report. */
export const PLATFORM_LESSON_REPORT_OUTCOMES = ['created', 'linked', 'skipped'] as const
export type PlatformLessonReportOutcome = (typeof PLATFORM_LESSON_REPORT_OUTCOMES)[number]

/** Every recordable pipeline/admin action on a lesson (append-only trail). */
export const PLATFORM_LESSON_EVENT_ACTIONS = [
  'created',
  'report_linked',
  'activated',
  'retired',
  'reactivated',
  'edited',
  'root_cause_updated',
  /**
   * Sweep verdict (0070): reports kept linking to this lesson AFTER it was
   * activated — the failure it exists to prevent is still happening, so the
   * bandage is demonstrably not holding. Recorded once per activation; the
   * lesson STAYS active (the wound is open) and the flag routes attention to
   * the root cause.
   */
  'flagged_ineffective',
] as const
export type PlatformLessonEventAction = (typeof PLATFORM_LESSON_EVENT_ACTIONS)[number]

export const platformLessons = pgTable(
  'platform_lessons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The injectable text: one anonymized, symptom-shaped corrective in German,
     * written by the distiller model and screened by the auditor model. This is
     * the ONLY column that ever reaches a tenant's prompt.
     */
    content: text('content').notNull(),
    category: text('category').$type<PlatformLessonCategory>().notNull(),
    status: text('status').$type<PlatformLessonStatus>().notNull().default('candidate'),
    /**
     * Why the automatic gate did not activate this lesson (null once a human or
     * the gate itself activates it): 'audit_flagged' | 'not_generalizable'.
     */
    heldReason: text('held_reason'),
    /** Denormalized from platform_lesson_reports, maintained transactionally. */
    reportCount: integer('report_count').notNull().default(1),
    /** Distinct pseudonymous orgs behind those reports (count of org hashes). */
    orgCount: integer('org_count').notNull().default(1),
    firstReportedAt: timestamp('first_reported_at', { withTimezone: true }).notNull().defaultNow(),
    lastReportedAt: timestamp('last_reported_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /** 'system:distiller' for the automatic gate, a WorkOS user id for a human. */
    activatedBy: text('activated_by'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    retiredBy: text('retired_by'),
    /** 'evicted_capacity' | 'root_cause_closed' | free text from the owner. */
    retiredReason: text('retired_reason'),
    rootCauseStatus: text('root_cause_status')
      .$type<PlatformLessonRootCauseStatus>()
      .notNull()
      .default('open'),
    rootCauseNote: text('root_cause_note'),
    /**
     * Semantic vector for the lesson text plus its model fingerprint
     * (migration 0069). This is what makes dedup find a restatement that
     * shares no tokens; a NULL vector, or one from a retired embedding model,
     * degrades matching to the rank-window path rather than failing.
     */
    embedding: real('embedding').array(),
    embeddingModel: text('embedding_model'),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    /**
     * Up/down votes cast while this lesson was active. With an always-injected
     * digest, exposure is a function of TIME, so this is a temporal
     * correlation and NOT attribution — every active lesson is counted for
     * every vote in its window. It is labelled as correlation in the UI, and
     * the holdout experiment (`lessons.holdout_pct`) is the credible measure
     * beside it.
     */
    helpfulVotes: integer('helpful_votes').notNull().default(0),
    harmfulVotes: integer('harmful_votes').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('idx_platform_lessons_status').on(table.status),
    // NOTE: migration 0068 additionally creates a partial UNIQUE expression
    // index on normalized content over non-retired rows (the exact-duplicate
    // race backstop) plus CHECK constraints pinning the enum vocabularies —
    // drizzle cannot express either, so the SQL is authoritative there.
  })
)

/**
 * Provenance, one row per processed down-vote — the pipeline's idempotency key
 * (`feedback_id` unique) and the audit chain's middle link.
 *
 * Deliberately carries NO tenant identity: `org_hash` is sha256 of the WorkOS
 * org id (enough to count distinct organizations, nothing more) and
 * `feedback_id` is an opaque pointer whose dereference — the raw comment, the
 * user, the organization — lives in the RLS-guarded `answer_feedback` table
 * and requires the audited platform bypass. `canonical_summary` is the
 * anonymized restatement the distiller produced, kept so provenance survives
 * the user retracting (deleting) the underlying vote.
 */
export const platformLessonReports = pgTable(
  'platform_lesson_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** answer_feedback.id, without an FK: a retracted vote must not erase the
     * provenance of a lesson that was already distilled from it. */
    feedbackId: uuid('feedback_id').notNull(),
    /** Null for outcome 'skipped' — the report produced no lesson. */
    lessonId: uuid('lesson_id').references(() => platformLessons.id, { onDelete: 'cascade' }),
    outcome: text('outcome').$type<PlatformLessonReportOutcome>().notNull(),
    /** 'not_generalizable' | 'no_signal' — why a skipped report was skipped. */
    skipReason: text('skip_reason'),
    /** sha256 hex of the reporting organization's id. Pseudonymous on purpose. */
    orgHash: text('org_hash').notNull(),
    canonicalSummary: text('canonical_summary'),
    /** The reporter's down-vote reason chip, for category statistics. */
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    feedbackUidx: uniqueIndex('platform_lesson_reports_feedback_uidx').on(table.feedbackId),
    lessonIdx: index('idx_platform_lesson_reports_lesson').on(table.lessonId),
  })
)

/**
 * Append-only event log — the "fully auditable" half of the loop. Every
 * transition a lesson goes through, whether the actor was the pipeline
 * ('system:distiller') or a platform owner, lands here; nothing is ever
 * updated or deleted, so the current state of any lesson is reconstructible
 * from its events. Admin actions are ADDITIONALLY audited to WorkOS
 * (platform.lesson.updated) like every other privileged platform mutation;
 * this table exists because the pipeline's own actions have no WorkOS actor
 * and because the trail must be joinable to lessons and reports.
 */
export const platformLessonEvents = pgTable(
  'platform_lesson_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => platformLessons.id, { onDelete: 'cascade' }),
    action: text('action').$type<PlatformLessonEventAction>().notNull(),
    /** 'system:distiller' | 'system:sweep' | a WorkOS user id. */
    actor: text('actor').notNull(),
    actorEmail: text('actor_email'),
    /** Flat primitives only — mirrors the WorkOS audit metadata discipline. */
    detail: jsonb('detail').$type<Record<string, string | number | boolean>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lessonIdx: index('idx_platform_lesson_events_lesson').on(table.lessonId, table.createdAt),
  })
)

export type PlatformLesson = typeof platformLessons.$inferSelect
export type NewPlatformLesson = typeof platformLessons.$inferInsert
export type PlatformLessonReport = typeof platformLessonReports.$inferSelect
export type NewPlatformLessonReport = typeof platformLessonReports.$inferInsert
export type PlatformLessonEvent = typeof platformLessonEvents.$inferSelect
export type NewPlatformLessonEvent = typeof platformLessonEvents.$inferInsert
