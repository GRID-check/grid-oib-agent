import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { projects } from './projects'
import type { WorkflowDefinition } from '@/lib/workflows/types'

/**
 * Workflows — saved research briefs scoped to a single project (and therefore
 * to one organization), run manually or on a cron schedule through the
 * existing async deep-research pipeline. See ADR-0023 and
 * docs/architecture/workflows.md.
 *
 * Mirrors the `project_memory` shape: a denormalized `organization_id` beside a
 * cascading `project_id` FK (never a cross-tenant FK — ADR-0007). The prompt is
 * compiled from the block `definition` once, at save time, in the BFF and
 * stored on `compiled_prompt`; the scheduler and manual-run path submit that
 * stored text verbatim (the WYSIWYG contract).
 */

export const WORKFLOW_TRIGGERS = ['manual', 'schedule'] as const
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number]

export const WORKFLOW_RUN_STATUSES = ['submitted', 'skipped', 'error'] as const
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number]

/** Default (and, today, only) agent a workflow drives. */
export const DEFAULT_WORKFLOW_AGENT_TYPE = 'deep_researcher'

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    definition: jsonb('definition').$type<WorkflowDefinition>().notNull(),
    compiledPrompt: text('compiled_prompt').notNull(),
    agentType: text('agent_type').notNull().default(DEFAULT_WORKFLOW_AGENT_TYPE),
    // null = all sources available to the agent.
    dataSources: jsonb('data_sources').$type<string[]>(),
    enabled: boolean('enabled').notNull().default(true),
    // 5-field cron; NULL = manual-only.
    scheduleCron: text('schedule_cron'),
    scheduleTimezone: text('schedule_timezone').notNull().default('UTC'),
    // Computed at save time by the BFF; NULL when no cron or disabled.
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdByEmail: text('created_by_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index('idx_workflows_project_id').on(table.projectId),
    orgIdx: index('idx_workflows_organization_id').on(table.organizationId),
    // NOTE: the partial due-scan index `idx_workflows_due` on (next_run_at)
    // WHERE schedule_cron IS NOT NULL AND enabled is a PARTIAL index the
    // drizzle builder can't express, so it lives in migration
    // 0017_workflows.sql. It backs the scheduler's due-row claim.
  }),
)

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    organizationId: text('organization_id').notNull(),
    // Backend async-job id; NULL when skipped/error.
    jobId: text('job_id'),
    trigger: text('trigger').$type<WorkflowTrigger>().notNull(),
    status: text('status').$type<WorkflowRunStatus>().notNull(),
    // Skip reason (e.g. org job cap) or submission error.
    detail: text('detail'),
    promptSnapshot: text('prompt_snapshot').notNull(),
    // User id for manual runs, 'scheduler' for cron.
    triggeredBy: text('triggered_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Created via `("workflow_id","created_at" DESC)` in the SQL migration so
    // the newest-first run-history query is a plain index scan.
    workflowCreatedIdx: index('idx_workflow_runs_workflow_created').on(table.workflowId, table.createdAt),
    projectIdx: index('idx_workflow_runs_project_id').on(table.projectId),
    orgIdx: index('idx_workflow_runs_organization_id').on(table.organizationId),
    // Standalone created_at index: the scheduler's retention prune filters and
    // orders by created_at alone, which the composite (workflow_id, created_at)
    // index cannot serve without a workflow_id predicate.
    createdIdx: index('idx_workflow_runs_created_at').on(table.createdAt),
  }),
)

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  project: one(projects, { fields: [workflows.projectId], references: [projects.id] }),
  runs: many(workflowRuns),
}))

export const workflowRunsRelations = relations(workflowRuns, ({ one }) => ({
  workflow: one(workflows, { fields: [workflowRuns.workflowId], references: [workflows.id] }),
}))

export type Workflow = typeof workflows.$inferSelect
export type NewWorkflow = typeof workflows.$inferInsert
export type WorkflowRun = typeof workflowRuns.$inferSelect
export type NewWorkflowRun = typeof workflowRuns.$inferInsert
