-- Manual down migration (drizzle-kit has no down support; mirrors 0019/0020/
-- 0021's convention). Drops the agent profiler span ledger table and its indexes.
DROP INDEX IF EXISTS "agent_profiler_spans_conversation_started_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_profiler_spans_conversation_turn_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_profiler_spans_org_created_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_profiler_spans";
