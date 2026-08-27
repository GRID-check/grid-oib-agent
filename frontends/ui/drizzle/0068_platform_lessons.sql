-- Platform lessons — the product's own correction ratchet
-- (docs/architecture/platform-failure-learning.md; the doctrine is
-- docs/contributing/correction-ratchet.md: "human intervention is a failure
-- signal").
--
-- A down-vote on an answer is a human stepping in. These three tables turn
-- that signal into an anonymized, deduplicated LESSON that reaches every
-- agent turn, so a failure a user reported once does not have to be reported
-- twice — while Platform → Lessons presents each lesson honestly as a
-- symptomatic bandage whose root cause is still open until somebody closes it.
--
-- Global by design — NO organization_id anywhere here. Provenance is kept by
-- reference: the feedback row's uuid (an opaque pointer whose dereference is
-- an audited platform-bypass read of the RLS-guarded answer_feedback table)
-- plus a sha256 org hash that supports "how many distinct organizations hit
-- this" without naming any of them.
CREATE TABLE IF NOT EXISTS "platform_lessons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The injectable text: one anonymized, symptom-shaped corrective (German),
  -- written by the distiller LLM and screened by the auditor LLM. The only
  -- column that ever reaches a tenant's prompt.
  "content" text NOT NULL,
  "category" text NOT NULL,
  -- candidate → active → retired. Retired rows are kept forever: the audit
  -- trail must be able to say what the fleet was told, and when that stopped.
  "status" text DEFAULT 'candidate' NOT NULL,
  -- Why the automatic gate held a candidate back (audit_flagged /
  -- not_generalizable); NULL once activated.
  "held_reason" text,
  "report_count" integer DEFAULT 1 NOT NULL,
  "org_count" integer DEFAULT 1 NOT NULL,
  "first_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  "activated_by" text,
  "retired_at" timestamp with time zone,
  "retired_by" text,
  "retired_reason" text,
  -- The bandage marker: a lesson patches a symptom; this says whether the
  -- underlying cause was ever fixed. Independent of status on purpose — an
  -- addressed cause retires the lesson only when a human verifies the fix.
  "root_cause_status" text DEFAULT 'open' NOT NULL,
  "root_cause_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The vocabularies, pinned where nobody has to remember them. An
  -- unrecognised status would silently fall out of both the digest (active
  -- only) and the candidate review list.
  CONSTRAINT "platform_lessons_status_check"
    CHECK ("status" IN ('candidate', 'active', 'retired')),
  CONSTRAINT "platform_lessons_category_check"
    CHECK ("category" IN ('inaccurate', 'too_slow', 'wrong_source', 'other')),
  CONSTRAINT "platform_lessons_root_cause_check"
    CHECK ("root_cause_status" IN ('open', 'addressed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_lessons_status" ON "platform_lessons"("status");
--> statement-breakpoint
-- Exact-duplicate race backstop, same shape as project_memory's 0010 indexes:
-- at most one live (non-retired) lesson per normalized content. The
-- normalization KEEPS umlauts and ß — lessons are German and "Maß" vs "Mas"
-- are different words — which is a deliberate divergence from project_memory's
-- ASCII normalizer; the JS twin is normalizeContentGerman in
-- src/lib/knowledge/consolidation.ts and the two must change in lock-step.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_platform_lessons_content_live"
  ON "platform_lessons" (btrim(regexp_replace(lower("content"), '[^a-z0-9äöüß]+', ' ', 'g')))
  WHERE "status" <> 'retired';
--> statement-breakpoint
-- Provenance, one row per processed down-vote. feedback_id is UNIQUE — the
-- pipeline's idempotency key — and carries NO foreign key: a user retracting
-- (deleting) their vote must not erase the provenance of a lesson that was
-- already distilled from it. canonical_summary is the anonymized restatement,
-- durable for the same reason.
CREATE TABLE IF NOT EXISTS "platform_lesson_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "feedback_id" uuid NOT NULL,
  "lesson_id" uuid REFERENCES "platform_lessons"("id") ON DELETE CASCADE,
  "outcome" text NOT NULL,
  "skip_reason" text,
  "org_hash" text NOT NULL,
  "canonical_summary" text,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_lesson_reports_outcome_check"
    CHECK ("outcome" IN ('created', 'linked', 'skipped')),
  -- A report either produced/joined a lesson or says why it did not; a row
  -- claiming both (or neither) would make the provenance chain ambiguous.
  CONSTRAINT "platform_lesson_reports_lesson_or_skip"
    CHECK (("outcome" = 'skipped' AND "lesson_id" IS NULL)
        OR ("outcome" <> 'skipped' AND "lesson_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_lesson_reports_feedback_uidx"
  ON "platform_lesson_reports"("feedback_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_lesson_reports_lesson"
  ON "platform_lesson_reports"("lesson_id");
--> statement-breakpoint
-- Append-only event log — the auditable half of "fully automatic". Every
-- transition, whether the actor was the pipeline (system:distiller) or a
-- platform owner, lands here and is never updated or deleted.
CREATE TABLE IF NOT EXISTS "platform_lesson_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lesson_id" uuid NOT NULL REFERENCES "platform_lessons"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "actor" text NOT NULL,
  "actor_email" text,
  "detail" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_lesson_events_action_check"
    CHECK ("action" IN ('created', 'report_linked', 'activated', 'retired',
                        'reactivated', 'edited', 'root_cause_updated'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_lesson_events_lesson"
  ON "platform_lesson_events"("lesson_id", "created_at");
--> statement-breakpoint
-- The sweep's anti-join ("down-votes with no report row yet, newest window")
-- scans answer_feedback by verdict + created_at on every kick. Down-votes are
-- the small minority of a table that grows with every thumb in the product, so
-- the partial index keeps that scan proportional to the down-votes in the
-- window rather than to the table.
CREATE INDEX IF NOT EXISTS "idx_answer_feedback_down_created"
  ON "answer_feedback"("created_at") WHERE "verdict" = 'down';

-- ---------------------------------------------------------------------------
-- The tenant boundary (ADR-0041). All three hold NO tenant data — the content
-- is anonymized by construction and provenance is pseudonymous — and all
-- writes happen in the pipeline or the platform dashboard, so they join the
-- boundary as PLATFORM tables: readable by every tenant role, writable only
-- under the audited platform bypass. The digest each tenant's turns receive is
-- built from platform_lessons.content, which is exactly the column that is
-- safe for every tenant to see.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
SELECT grid_secure_platform_table('platform_lessons');
--> statement-breakpoint
SELECT grid_secure_platform_table('platform_lesson_reports');
--> statement-breakpoint
SELECT grid_secure_platform_table('platform_lesson_events');
--> statement-breakpoint
-- Tighter than the platform-table norm, deliberately. The helper grants every
-- tenant SELECT because fleet configuration is meant to be read per tenant
-- (model defaults, skills). No tenant-facing code reads ANY lesson table: the
-- injected digest is built under the platform role behind the internal route.
-- And one of these tables holds text that must not be one tenant-side bug away
-- from other organizations — a CANDIDATE lesson is exactly the text the
-- auditor model flagged as possibly identifying. So the read grant is revoked
-- and the three tables are platform-role-only in both directions.
REVOKE SELECT ON "platform_lessons" FROM grid_app_rw;
--> statement-breakpoint
REVOKE SELECT ON "platform_lesson_reports" FROM grid_app_rw;
--> statement-breakpoint
REVOKE SELECT ON "platform_lesson_events" FROM grid_app_rw;
