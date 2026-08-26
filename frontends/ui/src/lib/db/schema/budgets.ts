import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * LLM spend limits + auditable usage ledger (ADR-0015,
 * docs/architecture/usage-budgets.md).
 *
 * `budget_policies` — the configured limits. Append-only with the repo's
 * supersede idiom (project_memory): changing a limit writes a new `active`
 * row and marks the old one `superseded`, so every limit change is auditable
 * (who, when, from what to what). One active policy per (org, scope, subject).
 *
 * Scopes:
 *  - `organization`  — the org-wide cap (subjectId NULL). Defaults seeded
 *    lazily: €10/day, €100/month until an admin changes them.
 *  - `member`        — per-person cap (subjectId = WorkOS user id). Must not
 *    exceed the org limits (validated in the service layer).
 *  - `project`       — per-project cap (subjectId = project uuid as text).
 *    Settable by project admins and org admins; must not exceed org limits.
 *
 * `llm_usage_events` — append-only ledger, one row per LLM generation, written
 * only via the token-guarded internal endpoint (single-writer rule). Cost is
 * stored in USD exactly as OpenRouter reports it (`usage.cost`); EUR budgets
 * are compared after conversion at read time (GRID_BUDGET_EUR_PER_USD).
 * `generation_id` allows post-hoc reconciliation against OpenRouter's
 * GET /api/v1/generation endpoint.
 */

export const BUDGET_SCOPES = ['organization', 'member', 'project'] as const
export type BudgetScope = (typeof BUDGET_SCOPES)[number]

export const BUDGET_POLICY_STATUSES = ['active', 'superseded'] as const
export type BudgetPolicyStatus = (typeof BUDGET_POLICY_STATUSES)[number]

export const budgetPolicies = pgTable(
  'budget_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    scope: text('scope').$type<BudgetScope>().notNull(),
    /** NULL for org scope; WorkOS user id (member) or project uuid (project). */
    subjectId: text('subject_id'),
    /** Limits in `currency`; NULL = no limit for that window. */
    dailyLimit: numeric('daily_limit', { precision: 12, scale: 4 }),
    monthlyLimit: numeric('monthly_limit', { precision: 12, scale: 4 }),
    currency: text('currency').notNull().default('EUR'),
    status: text('status').$type<BudgetPolicyStatus>().notNull().default('active'),
    supersedesId: uuid('supersedes_id'),
    /** WorkOS user id of whoever set this policy. */
    createdBy: text('created_by').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgScopeIdx: index('idx_budget_policies_org_scope').on(
      table.organizationId,
      table.scope,
      table.subjectId,
      table.status
    ),
    // NOTE: a PARTIAL UNIQUE index enforcing "one active policy per
    // (org, scope, subject)" lives in the hand-written part of the migration
    // (uniq_budget_policies_active) — drizzle's builder can't express
    // COALESCE-expression partial indexes (same pattern as 0010).
  })
)

export const COST_SOURCES = ['usage_field', 'missing', 'generation_api', 'estimate'] as const
export type CostSource = (typeof COST_SOURCES)[number]

export const llmUsageEvents = pgTable(
  'llm_usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /** WorkOS user id of the requesting member (NULL for anonymous mode). */
    userId: text('user_id'),
    /** Project uuid as text — no FK so ledger rows survive project deletion (audit). */
    projectId: text('project_id'),
    conversationId: text('conversation_id'),
    /** Async job id when the generation ran inside a Dask worker. */
    jobId: text('job_id'),
    /** Agent group (reserved — not populated by the v1 tracker). */
    agentGroup: text('agent_group'),
    /** Model id the request asked for (post-override). */
    requestedModel: text('requested_model'),
    /** Model id OpenRouter actually served (from the response). */
    model: text('model'),
    /** OpenRouter generation id (`gen-…`) for reconciliation. */
    generationId: text('generation_id'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    /** Cost in USD exactly as reported by OpenRouter usage accounting. */
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 }).notNull().default('0'),
    costSource: text('cost_source').$type<CostSource>().notNull().default('missing'),
    isByok: boolean('is_byok'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgTimeIdx: index('idx_llm_usage_events_org_time').on(table.organizationId, table.createdAt),
    orgUserTimeIdx: index('idx_llm_usage_events_org_user_time').on(
      table.organizationId,
      table.userId,
      table.createdAt
    ),
    orgProjectTimeIdx: index('idx_llm_usage_events_org_project_time').on(
      table.organizationId,
      table.projectId,
      table.createdAt
    ),
    orgModelTimeIdx: index('idx_llm_usage_events_org_model_time').on(
      table.organizationId,
      table.model,
      table.createdAt
    ),
  })
)

/**
 * `llm_usage_rollups` — write-through daily spend aggregate (ADR-0019).
 *
 * One row per (org, UTC day, user, project); maintained in the SAME
 * transaction as the `llm_usage_events` insert, so it is exact, not a cache.
 * Budget enforcement reads a handful of rollup rows instead of aggregating
 * the month's ledger on every WebSocket upgrade. Empty string stands in for
 * "no user"/"no project" so the composite primary key stays non-null.
 */
export const llmUsageRollups = pgTable(
  'llm_usage_rollups',
  {
    organizationId: text('organization_id').notNull(),
    /** UTC day the spend belongs to. */
    day: date('day').notNull(),
    userId: text('user_id').notNull().default(''),
    projectId: text('project_id').notNull().default(''),
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 }).notNull().default('0'),
    events: integer('events').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'llm_usage_rollups_pk',
      columns: [table.organizationId, table.day, table.userId, table.projectId],
    }),
    orgUserDayIdx: index('idx_llm_usage_rollups_org_user_day').on(
      table.organizationId,
      table.userId,
      table.day
    ),
    orgProjectDayIdx: index('idx_llm_usage_rollups_org_project_day').on(
      table.organizationId,
      table.projectId,
      table.day
    ),
  })
)

export type BudgetPolicy = typeof budgetPolicies.$inferSelect
export type NewBudgetPolicy = typeof budgetPolicies.$inferInsert
export type LlmUsageEvent = typeof llmUsageEvents.$inferSelect
export type NewLlmUsageEvent = typeof llmUsageEvents.$inferInsert
export type LlmUsageRollup = typeof llmUsageRollups.$inferSelect
