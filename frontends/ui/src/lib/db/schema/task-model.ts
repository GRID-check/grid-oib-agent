/**
 * `task_definitions` and `task_runs` — the collapsed model of jobs, job_runs
 * and tasks (follow-up to PR #659).
 *
 * ## Why one entity and not three
 *
 * A recurring check and a one-off handover were never different species of
 * work. `jobs` + `job_runs` described a timer and its fires; `tasks` described
 * the thing a person delegated, including the ones a timer produced. Two rows
 * already described one execution: a scheduled fire wrote a `job_runs` row
 * (`status: submitted`) AND a `tasks` row, both keyed on the same backend job
 * id. The seam was historical, not modelled.
 *
 * The model is two nouns:
 *
 *   - {@link taskDefinitions} — the STANDING INTENT: what was asked, by whom,
 *     and what makes it run. A chat handover is that same row with a degenerate
 *     trigger (`once`, no due date), which is why chat can now say „jeden
 *     Montag".
 *   - {@link taskRuns} — one ATTEMPT, including the attempts that never
 *     reached the agent. `trigger`/`triggered_by` come from `job_runs`,
 *     `status`/`error`/timestamps from `tasks`, and filing/review live here
 *     because they are properties of a RESULT, not of the arrangement.
 *
 * ## What the run carries
 *
 * A run is self-describing: kind, title, plan (the prompt with its skill body,
 * the frozen data sources, the requester's goal) and the requester are copied
 * at fire time, exactly as `tasks` copied them. `definition_id` is nullable
 * with `ON DELETE SET NULL`, mirroring `tasks.job_id`'s promise that deleting
 * the arrangement never destroys the record of what it did — and unlike the old
 * `tasks.job_run_id`, which was SET NULL and lost only the LINK while the
 * schedule's runs were pruned around it.
 *
 * Ids are deliberately REUSED in the 0086 backfill: a job's definition id is
 * the job's own id, and a job-spawned run keeps the `job_runs` id. Nothing a
 * person can open (a conversation, a filed document, an inbox anchor) has to be
 * remapped.
 *
 * ## Status vocabulary
 *
 * The merged lifecycle lives in `task-vocabulary.ts` (`TASK_RUN_STATUSES`).
 * `skipped` and `error` are first-class: a fire that never reached the agent is
 * a visible row in Aufgaben, not a hidden `job_runs` line.
 */

import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { SkillSnapshot } from '@/lib/skills/types'
import {
  DEFINITION_TRIGGERS,
  TASK_RUN_STATUSES,
  TASK_RUN_TRIGGERS,
  type DefinitionTrigger,
  type TaskKind,
  type TaskReview,
  type TaskRunStatus,
  type TaskRunTrigger,
} from '@/lib/tasks/task-vocabulary'
import { projects } from './projects'
import type { TaskFilingStatus, TaskPlan } from './tasks'

/**
 * What the task was asked to do, frozen at definition time — the SAME shape
 * the old `tasks.plan` carried, so the wire projection and the filing paths
 * read one contract. Declared in `./tasks` (the table being replaced owns it
 * until 0087 drops it) and re-exported there for the callers that already
 * import it from `@/lib/db/schema`.
 */

export const taskDefinitions = pgTable(
  'task_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<TaskKind>().notNull(),
    /** The job's name, or the delegation's own title. What the list calls it. */
    title: text('title').notNull(),
    /**
     * The standing instruction, frozen. `prompt` is exactly what is submitted
     * (skill body included), `skill` is the pinned snapshot, `dataSources` the
     * allowed sources, and `goal`/`subject` the requester's own words when
     * there were any.
     */
    plan: jsonb('plan').$type<TaskPlan>().notNull(),
    /**
     * Whose permissions and budget the work spends. A WorkOS user id, never
     * `'scheduler'` — an unattended run files as somebody, and the somebody is
     * whoever asked.
     */
    requesterUserId: text('requester_user_id').notNull(),
    requesterEmail: text('requester_email'),
    /** What makes it run; see `DEFINITION_TRIGGERS`. */
    trigger: text('trigger').$type<DefinitionTrigger>().notNull(),
    /** Only a `manual` or `schedule` definition can be paused. */
    enabled: boolean('enabled').notNull().default(true),
    /** 5-field cron; live only when the trigger is `schedule`. */
    scheduleCron: text('schedule_cron'),
    scheduleTimezone: text('schedule_timezone').notNull().default('UTC'),
    /** Computed at save time; NULL when no cron, disabled, or not scheduled. */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /** When a `once` definition is wanted. NULL = immediately (a delegation). */
    dueAt: timestamp('due_at', { withTimezone: true }),
    /**
     * Ceiling the requester set, if they did. Recorded here and enforced by the
     * budget guard as every turn is; NULL inherits the organization's policies.
     */
    budgetUsd: numeric('budget_usd', { precision: 12, scale: 4 }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectCreatedIdx: index('idx_task_definitions_project_created').on(
      table.projectId,
      table.createdAt
    ),
    orgIdx: index('idx_task_definitions_organization_id').on(table.organizationId),
    // NOTE: the partial due-scan index `idx_task_definitions_due` on
    // (next_run_at) WHERE trigger = 'schedule' AND enabled is a PARTIAL index
    // the drizzle builder cannot express; it lives in migration 0086, the way
    // `idx_jobs_due` lives in 0043. It backs the scheduler's claim.
    triggerKnown: check(
      'task_definitions_trigger_known',
      sql`${table.trigger} IN ('manual', 'once', 'schedule')`
    ),
    /** A schedule has a cron; nothing else does. */
    cronOnlyWhenScheduled: check(
      'task_definitions_cron_only_when_scheduled',
      sql`(${table.trigger} = 'schedule') = (${table.scheduleCron} IS NOT NULL)`
    ),
    /** A due date exists only on a one-shot. */
    dueOnlyWhenOnce: check(
      'task_definitions_due_only_when_once',
      sql`${table.dueAt} IS NULL OR ${table.trigger} = 'once'`
    ),
    // No kind CHECK, deliberately, exactly as 0075 left `tasks.kind`: the
    // vocabulary lives in ONE place (`lib/tasks/task-vocabulary.ts`) rather
    // than in a column and a tuple that can disagree.
  })
)

export const taskRuns = pgTable(
  'task_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * The arrangement this attempt belongs to, when it still exists. Nullable
     * and SET NULL for the reason `tasks.job_id` was: history outlives the
     * thing that scheduled it.
     */
    definitionId: uuid('definition_id').references(() => taskDefinitions.id, {
      onDelete: 'set null',
    }),
    /** Copied at creation so a run explains itself after the definition is gone. */
    kind: text('kind').$type<TaskKind>().notNull(),
    title: text('title').notNull(),
    plan: jsonb('plan').$type<TaskPlan>().notNull(),
    requesterUserId: text('requester_user_id').notNull(),
    requesterEmail: text('requester_email'),
    /** How it started; see `TASK_RUN_TRIGGERS`. */
    trigger: text('trigger').$type<TaskRunTrigger>().notNull(),
    /** User id for manual/delegated runs, `'scheduler'` for cron. */
    triggeredBy: text('triggered_by'),
    /** Merged lifecycle; `skipped`/`error` are attempts that never reached the agent. */
    status: text('status').$type<TaskRunStatus>().notNull(),
    /** The skip reason or the sanitized, user-safe error. */
    error: text('error'),
    /** The definition's snapshot at fire time — `{}` for a skill-less prompt. */
    skillSnapshot: jsonb('skill_snapshot').$type<SkillSnapshot>().notNull(),
    /** The backend async-job id — the one id the worker holds. */
    backendJobId: text('backend_job_id'),
    /** The conversation an `output: 'chat'` run wrote into. */
    conversationId: text('conversation_id'),
    /** The document the result was filed as, when it was. */
    filedDocumentId: uuid('filed_document_id'),
    filingStatus: text('filing_status').$type<TaskFilingStatus>(),
    /** Operator-facing detail for a refused or failed filing. Never the client's. */
    filingDetail: text('filing_detail'),
    review: text('review').$type<TaskReview>(),
    /** The reviewer's words. On a rejection they reach the next run's prompt. */
    reviewReason: text('review_reason'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Created with `("definition_id","created_at" DESC)` in the migration so the
    // newest-first run history is a plain index scan.
    definitionCreatedIdx: index('idx_task_runs_definition_created').on(
      table.definitionId,
      table.createdAt
    ),
    // The unified Aufgaben list reads project-wide, not per-definition.
    projectCreatedIdx: index('idx_task_runs_project_created').on(table.projectId, table.createdAt),
    orgIdx: index('idx_task_runs_organization_id').on(table.organizationId),
    backendJobUidx: uniqueIndex('uniq_task_runs_backend_job_id')
      .on(table.backendJobId)
      .where(sql`${table.backendJobId} IS NOT NULL`),
    statusKnown: check(
      'task_runs_status_known',
      sql`${table.status} IN (${sql.join(
        TASK_RUN_STATUSES.map((status) => sql`${status}`),
        sql`, `
      )})`
    ),
    triggerKnown: check(
      'task_runs_trigger_known',
      sql`${table.trigger} IN (${sql.join(
        TASK_RUN_TRIGGERS.map((trigger) => sql`${trigger}`),
        sql`, `
      )})`
    ),
    reviewKnown: check(
      'task_runs_review_known',
      sql`${table.review} IS NULL OR ${table.review} IN ('accepted', 'rejected')`
    ),
    filingKnown: check(
      'task_runs_filing_status_known',
      sql`${table.filingStatus} IS NULL OR ${table.filingStatus} IN ('filed', 'refused', 'failed')`
    ),
    /** A review is a decision by somebody, at some time — all three or none. */
    reviewComplete: check(
      'task_runs_review_complete',
      sql`(${table.review} IS NULL) = (${table.reviewedBy} IS NULL) AND (${table.review} IS NULL) = (${table.reviewedAt} IS NULL)`
    ),
  })
)

export const taskDefinitionsRelations = relations(taskDefinitions, ({ one, many }) => ({
  project: one(projects, { fields: [taskDefinitions.projectId], references: [projects.id] }),
  runs: many(taskRuns),
}))

export const taskRunsRelations = relations(taskRuns, ({ one }) => ({
  project: one(projects, { fields: [taskRuns.projectId], references: [projects.id] }),
  definition: one(taskDefinitions, {
    fields: [taskRuns.definitionId],
    references: [taskDefinitions.id],
  }),
}))

export type TaskDefinition = typeof taskDefinitions.$inferSelect
export type NewTaskDefinition = typeof taskDefinitions.$inferInsert
export type TaskRun = typeof taskRuns.$inferSelect
export type NewTaskRun = typeof taskRuns.$inferInsert

export { DEFINITION_TRIGGERS, type DefinitionTrigger, TASK_RUN_TRIGGERS, type TaskRunTrigger, TASK_RUN_STATUSES, type TaskRunStatus }
