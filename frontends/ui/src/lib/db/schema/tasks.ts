/**
 * `tasks` — the durable unit of delegated work (ADR-0051).
 *
 * A job says WHEN Piloti should work; a job_run says THAT it was submitted;
 * the backend job store says HOW the run went and forgets it 24 hours later.
 * None of them was the thing a person delegated: something with a requester
 * whose permission it acts under, a lifecycle from queued to reviewed, a
 * result that lands somewhere durable, and a decision that reaches the next
 * attempt. That is this row.
 *
 * One task per attempt, by construction: `fireJob` creates it beside the
 * `job_runs` row, and the worker's outcome callback closes it. The requester
 * is PINNED at creation — the job's creator, never the scheduler and never a
 * service token — because unattended work must act as somebody, and the
 * somebody is whoever asked for it (`docs/superpowers/specs/2026-08-20-
 * agent-authored-documents-design.md`, decision 10).
 *
 * Review is a second, independent axis on the same row (the
 * `mention_requests` shape: a lifecycle `status`, and separately how it was
 * resolved). A rejection carries a reason, and that reason is read by the next
 * run of the same job — the one loop the roadmap named as the difference
 * between "a job" and "delegation".
 */

import { relations, sql } from 'drizzle-orm'
import { check, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { SkillSnapshot } from '@/lib/skills/types'
import { projects } from './projects'
import { jobRuns, jobs } from './jobs'

/**
 * What kind of work the task is. Today exactly the two job outputs; the next
 * members (`compliance_check`, `einreichcheck`) are the roadmap's, and they
 * arrive as a TypeScript change — plain text, no CHECK — the same arrangement
 * `documents.scope` has.
 */
export const TASK_KINDS = ['deep-research', 'chat'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

/**
 * The lifecycle. `queued` from creation until the worker reports; the three
 * terminal states are the worker's own outcome vocabulary, unchanged, so the
 * row says what the run store said before it forgot.
 */
export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'interrupted'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** How a person judged the result. Null until somebody did. */
export const TASK_REVIEWS = ['accepted', 'rejected'] as const
export type TaskReview = (typeof TASK_REVIEWS)[number]

/**
 * Whether the result was filed into the project, as the requester.
 *   - `filed`    — a document row exists; `filedDocumentId` names it.
 *   - `refused`  — the requester may not file here (left the organization,
 *                  lacks the permission, or the feature is off for the org).
 *   - `failed`   — filing was attempted and broke; `filingDetail` says how.
 * Null when there was nothing to file (a chat task, a failed run).
 */
export const TASK_FILING_STATUSES = ['filed', 'refused', 'failed'] as const
export type TaskFilingStatus = (typeof TASK_FILING_STATUSES)[number]

/**
 * What the task was asked to do, frozen at creation so the row explains
 * itself after the job it came from changed or vanished.
 */
export interface TaskPlan {
  /** The prompt exactly as it was submitted, skill body included. */
  prompt: string
  /** The skill it ran under, or `{}` for a plain prompt. */
  skill: SkillSnapshot
  /** Data sources the run was allowed to use. */
  dataSources: string[] | null
}

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<TaskKind>().notNull(),
    /** The job's name at the time — what the inbox and the list call it. */
    title: text('title').notNull(),
    plan: jsonb('plan').$type<TaskPlan>().notNull(),
    /**
     * Whose permission the task acts under, pinned at creation. A WorkOS user
     * id, never `'scheduler'`: unattended filing resolves THIS person's
     * membership and permissions at completion.
     */
    requesterUserId: text('requester_user_id').notNull(),
    requesterEmail: text('requester_email'),
    status: text('status').$type<TaskStatus>().notNull().default('queued'),
    /** The sanitized, user-safe error the worker reported, when it failed. */
    error: text('error'),
    /**
     * Ceiling and deadline the requester set. Recorded now, enforced by the
     * budget guard and the scheduler in the next step; a row with neither
     * inherits the organization's policies as every turn does.
     */
    budgetUsd: numeric('budget_usd', { precision: 12, scale: 4 }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    /** Where it came from. Nullable: a job may be deleted, the task remains. */
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    jobRunId: uuid('job_run_id').references(() => jobRuns.id, { onDelete: 'set null' }),
    /** The backend async-job id — the one id the worker holds when it reports. */
    backendJobId: text('backend_job_id'),
    /** The conversation an `output: 'chat'` task wrote into. */
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
    projectCreatedIdx: index('idx_tasks_project_created').on(table.projectId, table.createdAt),
    orgIdx: index('idx_tasks_organization_id').on(table.organizationId),
    jobIdx: index('idx_tasks_job_id').on(table.jobId),
    /**
     * The worker reports by backend job id; one task per backend job. Partial:
     * a task whose submission failed never got one.
     */
    backendJobUidx: uniqueIndex('uniq_tasks_backend_job_id')
      .on(table.backendJobId)
      .where(sql`${table.backendJobId} IS NOT NULL`),
    statusKnown: check('tasks_status_known', sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')`),
    reviewKnown: check('tasks_review_known', sql`${table.review} IS NULL OR ${table.review} IN ('accepted', 'rejected')`),
    filingKnown: check(
      'tasks_filing_status_known',
      sql`${table.filingStatus} IS NULL OR ${table.filingStatus} IN ('filed', 'refused', 'failed')`
    ),
    /** A review is a decision by somebody, at some time — all three or none. */
    reviewComplete: check(
      'tasks_review_complete',
      sql`(${table.review} IS NULL) = (${table.reviewedBy} IS NULL) AND (${table.review} IS NULL) = (${table.reviewedAt} IS NULL)`
    ),
  })
)

export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  job: one(jobs, { fields: [tasks.jobId], references: [jobs.id] }),
  jobRun: one(jobRuns, { fields: [tasks.jobRunId], references: [jobRuns.id] }),
}))

export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
