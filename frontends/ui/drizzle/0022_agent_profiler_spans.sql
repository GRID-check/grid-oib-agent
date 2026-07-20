-- Agent execution profiler ledger (timing sibling of llm_usage_events):
-- one row per span (turn / graph node / LLM call / tool call) captured by
-- src/aiq_agent/common/profiler.py and posted through the token-guarded
-- internal endpoint. No FK to conversations — ops/forensics data that must
-- survive conversation deletion, same rationale as llm_usage_events.
CREATE TABLE IF NOT EXISTS "agent_profiler_spans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text,
  "conversation_id" text,
  "turn_id" text NOT NULL,
  "job_id" text,
  "span_id" text NOT NULL,
  "parent_span_id" text,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "duration_ms" integer NOT NULL,
  "status" text DEFAULT 'ok' NOT NULL,
  "error_message" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Platform-wide cross-org browsing, most recent first.
CREATE INDEX IF NOT EXISTS "agent_profiler_spans_org_created_idx" ON "agent_profiler_spans"("organization_id","created_at");
--> statement-breakpoint
-- Pull one turn's full span tree (turnId groups every span of one run).
CREATE INDEX IF NOT EXISTS "agent_profiler_spans_conversation_turn_idx" ON "agent_profiler_spans"("conversation_id","turn_id");
--> statement-breakpoint
-- Per-conversation timeline ordering.
CREATE INDEX IF NOT EXISTS "agent_profiler_spans_conversation_started_idx" ON "agent_profiler_spans"("conversation_id","started_at");
