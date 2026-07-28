import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Citation-health ledger: one row per (research turn, defect kind) captured by
 * the backend's citation-quality emitter (src/aiq_agent/common/citation_events.py
 * — the quality sibling of the timing ledger in agent-profiler.ts and the cost
 * ledger in budgets.ts). Append-only, written only via the token-guarded
 * internal endpoint POST /api/internal/citation-events; grid_app stays
 * single-writer.
 *
 * Every observed research turn writes exactly one `turn_verified` row — the
 * denominator behind the platform dashboard's clean rate — plus one row per
 * defect that turn hit. That shape keeps "turns observed" and "turns with
 * defect X" both a plain COUNT instead of a jsonb scan.
 *
 * No FK to `conversations` or `projects`: like `llm_usage_events`, this is
 * ops/quality data that must survive conversation deletion. It also carries no
 * user content — only machine reason keys, counts, and coarse source labels
 * (origin/lane/tool), so the ledger is safe to browse cross-organization.
 * Read by the platform-owner-only citation-health surface
 * (lib/citations/*, /api/platform/citation-health).
 */

/** Defect taxonomy — keep in sync with `SEVERITY_BY_KIND` in citation_events.py. */
export const CITATION_EVENT_KINDS = [
  /** Baseline row: one per observed research turn (the clean-rate denominator). */
  'turn_verified',
  /** `verify_citations` dropped >=1 citation the model wrote. */
  'citations_removed',
  /** A quoted span was not found in any retrieved passage (fabricated quote). */
  'quote_unverified',
  /** Sources existed but nothing verifiable was cited — the "Ohne Quellenangabe" gap. */
  'answer_ungrounded',
  /** Retrieval captured nothing at all; the turn fails rather than answering ungrounded. */
  'registry_empty',
  /** Nothing the model cited survived; the single registry source was appended for it. */
  'citation_fallback',
  /** The overconfidence guard capped the surfaced confidence to "low". */
  'confidence_capped',
] as const
export type CitationEventKind = (typeof CITATION_EVENT_KINDS)[number]

export const CITATION_EVENT_SEVERITIES = ['ok', 'info', 'warn', 'error'] as const
export type CitationEventSeverity = (typeof CITATION_EVENT_SEVERITIES)[number]

/** Which research agent produced the turn. */
export const CITATION_EVENT_AGENTS = ['shallow', 'deep'] as const
export type CitationEventAgent = (typeof CITATION_EVENT_AGENTS)[number]

/** The only kind that is not a defect — everything else counts against a turn. */
export const CITATION_BASELINE_KIND: CitationEventKind = 'turn_verified'

export const citationEvents = pgTable(
  'citation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id'),
    /** Client-side conversation id — no FK, see module docstring. */
    conversationId: text('conversation_id'),
    /** Shared with `agent_profiler_spans.turnId`, so a defect links to its timeline. */
    turnId: text('turn_id').notNull(),
    /** Async deep-research job id, when the turn ran inside a Dask worker. */
    jobId: text('job_id'),
    agent: text('agent').$type<CitationEventAgent>().notNull(),
    kind: text('kind').$type<CitationEventKind>().notNull(),
    severity: text('severity').$type<CitationEventSeverity>().notNull(),
    /** How many items the row covers (citations dropped, quotes unverified, …). */
    count: integer('count').notNull().default(1),
    /** Machine reason key -> occurrences, e.g. `{"url_not_in_registry": 2}`. */
    reasons: jsonb('reasons').$type<Record<string, number> | null>(),
    /** Coarse, non-prose context: source/cited counts, origin+lane+tool mixes. */
    detail: jsonb('detail').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** A retried flush must not double-count a defect. */
    turnKindUidx: uniqueIndex('citation_events_turn_kind_uidx').on(table.turnId, table.kind),
    createdKindIdx: index('citation_events_created_kind_idx').on(table.createdAt, table.kind),
    orgCreatedIdx: index('citation_events_org_created_idx').on(table.organizationId, table.createdAt),
    conversationCreatedIdx: index('citation_events_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
  }),
)

export type CitationEvent = typeof citationEvents.$inferSelect
export type NewCitationEvent = typeof citationEvents.$inferInsert
