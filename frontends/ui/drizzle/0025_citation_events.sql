-- Citation-health ledger (quality sibling of llm_usage_events / agent_profiler_spans):
-- one row per (research turn, defect kind) captured by
-- src/aiq_agent/common/citation_events.py and posted through the token-guarded
-- internal endpoint. Every observed research turn writes exactly one
-- 'turn_verified' baseline row — that is the denominator behind the clean rate —
-- plus one row per defect detected on that turn.
--
-- No FK to conversations/projects: ops/quality data that must survive
-- conversation deletion, same rationale as llm_usage_events. Carries no user
-- prose — only machine reason keys, counts, and coarse source labels.
CREATE TABLE IF NOT EXISTS "citation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text,
  "conversation_id" text,
  "turn_id" text NOT NULL,
  "job_id" text,
  "agent" text NOT NULL,
  "kind" text NOT NULL,
  "severity" text NOT NULL,
  "count" integer DEFAULT 1 NOT NULL,
  "reasons" jsonb,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One row per (turn, kind): a retried flush must not double-count a defect.
CREATE UNIQUE INDEX IF NOT EXISTS "citation_events_turn_kind_uidx" ON "citation_events"("turn_id","kind");
--> statement-breakpoint
-- Serves the platform dashboard's windowed rollups (kind mix, daily trend).
CREATE INDEX IF NOT EXISTS "citation_events_created_kind_idx" ON "citation_events"("created_at","kind");
--> statement-breakpoint
-- Per-organization breakdown within the same window.
CREATE INDEX IF NOT EXISTS "citation_events_org_created_idx" ON "citation_events"("organization_id","created_at");
--> statement-breakpoint
-- Drill-down from a flagged conversation to its turns.
CREATE INDEX IF NOT EXISTS "citation_events_conversation_created_idx" ON "citation_events"("conversation_id","created_at");
