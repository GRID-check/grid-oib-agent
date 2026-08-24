import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Agent execution profiler ledger: one row per span (turn / graph node / LLM
 * call / tool call) captured by the backend's unified profiler
 * (src/aiq_agent/common/profiler.py — the timing sibling of the LLM cost
 * ledger in budgets.ts). Append-only, written only via the token-guarded
 * internal endpoint POST /api/internal/agent-profiler-spans; grid_app stays
 * single-writer.
 *
 * No FK to `conversations`: like `llm_usage_events`, this is ops/forensics
 * data that must survive conversation deletion, not user content. Spans
 * nest via `parentSpanId` (`spanId`s are backend-generated uuid4 strings,
 * not the row's own `id`); a span with `parentSpanId IS NULL` is the root
 * "turn" span for one `turnId`. Read by the platform-owner-only profiler
 * timeline (lib/profiler/*, /api/platform/profiler/**).
 */

export const SPAN_KINDS = ['turn', 'node', 'llm', 'tool'] as const
export type SpanKind = (typeof SPAN_KINDS)[number]

export const SPAN_STATUSES = ['ok', 'error'] as const
export type SpanStatus = (typeof SPAN_STATUSES)[number]

export const agentProfilerSpans = pgTable(
  'agent_profiler_spans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id'),
    /** Client-side conversation id — no FK, see module docstring. */
    conversationId: text('conversation_id'),
    /** Groups every span of one backend track_agent_profile() call (one turn/job run). */
    turnId: text('turn_id').notNull(),
    /** Async deep-research job id, when the turn ran inside a Dask worker. */
    jobId: text('job_id'),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    kind: text('kind').$type<SpanKind>().notNull(),
    name: text('name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    status: text('status').$type<SpanStatus>().notNull().default('ok'),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgCreatedIdx: index('agent_profiler_spans_org_created_idx').on(table.organizationId, table.createdAt),
    conversationTurnIdx: index('agent_profiler_spans_conversation_turn_idx').on(
      table.conversationId,
      table.turnId,
    ),
    conversationStartedIdx: index('agent_profiler_spans_conversation_started_idx').on(
      table.conversationId,
      table.startedAt,
    ),
  }),
)

export type AgentProfilerSpan = typeof agentProfilerSpans.$inferSelect
export type NewAgentProfilerSpan = typeof agentProfilerSpans.$inferInsert
