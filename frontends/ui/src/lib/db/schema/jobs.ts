import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { projects } from './projects'
import type { SkillSnapshot } from '@/lib/skills/types'

/**
 * Jobs and Agent Skills (docs/architecture/agent-skills.md) — a project-scoped
 * prompt on a timer, the org toolbox of agentskills.io-format skills it may
 * draw on, and the submission history.
 *
 * **A job is a prompt on a timer.** It fires into a fresh run the way a person
 * opening a new chat and typing would, and a skill MAY be attached on top —
 * exactly as typing `/name` before the message would attach it. That is the
 * whole relationship: a skill knows nothing about time, and a job needs no
 * skill.
 *
 * This is the shape migration 0043 renamed `skill_schedules`/`skill_runs` into.
 * The old shape made the skill the subject and derived the prompt from it,
 * which left "ask this question every Monday" unexpressible without inventing a
 * skill for it, and put a scheduling concern into skill metadata.
 *
 * `jobs` snapshots the attached skill at save time (`skill_snapshot`), so a run
 * is a deterministic copy that cannot drift when the skill is later edited —
 * the "compiled prompt" contract, mirrored as JSONB. `job_runs` carries its own
 * copy of the snapshot, so run history stays self-describing.
 *
 * Platform-authored skills are NOT rows here: they ship as files under
 * `src/aiq_agent/skills/builtin/<collection>/` and arrive via the generated
 * `@/lib/skills/platform-skills` module. The `skills` table holds org-authored
 * (and cloned) skills only.
 */

export const SKILL_ORIGINS = ['org', 'platform-clone'] as const
export type SkillOrigin = (typeof SKILL_ORIGINS)[number]

/**
 * What a job produces — the user's choice on the job, and the only thing that
 * decides which agent runs it.
 *
 *   - `chat`          shallow_researcher; the finished run is materialised into
 *                     a real conversation the user can open and continue.
 *   - `deep-research` deep_researcher; the finished run is a report.
 *
 * Was `SKILL_EXECUTIONS`, denormalised from the skill's `grid-execution`
 * metadata key. Same two values, same agent mapping; only the source moved.
 * A skill has no opinion about how its output is delivered — the person
 * scheduling it does.
 */
export const JOB_OUTPUTS = ['chat', 'deep-research'] as const
export type JobOutput = (typeof JOB_OUTPUTS)[number]

export const JOB_RUN_TRIGGERS = ['manual', 'schedule'] as const
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number]

export const JOB_RUN_STATUSES = ['submitted', 'skipped', 'error'] as const
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number]

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Lowercase a-z/0-9/hyphens, no leading/trailing/consecutive hyphens
    // (agentskills.io name rule) — validated by skillNameSchema at the routes.
    name: text('name').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull(),
    // Reserved keys read at resolve time: grid-agents (who may use it — the one
    // availability gate) and grid-cards (preferred output cards). See
    // lib/skills/types.ts. Scheduling and output delivery are NOT here: they
    // are properties of the job that attaches the skill.
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    // 'org' = authored in this organization; 'platform-clone' = cloned from a
    // platform skill (cloned_from carries the platform name).
    origin: text('origin').$type<SkillOrigin>().notNull().default('org'),
    clonedFrom: text('cloned_from'),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdByEmail: text('created_by_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex('idx_skills_org_name').on(table.organizationId, table.name),
    orgIdx: index('idx_skills_organization_id').on(table.organizationId),
  })
)

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    /**
     * The scheduled prompt — what the job actually is.
     *
     * Fires as if typed into a new chat. When a skill is attached its body is
     * appended by the shared prompt builder, so the preview the UI shows is
     * that same function's output rather than a second implementation of it.
     */
    prompt: text('prompt').notNull(),
    /**
     * The attached skill, or NULL.
     *
     * Nullable since 0043, and that is the point of the change rather than a
     * loosening of it: the common case is a plain prompt on a timer, and the
     * old NOT NULL forced every such job to invent a skill it did not want.
     *
     * NULL here iff `skillSnapshot` is NULL — the database enforces the pair
     * with `jobs_skill_pair_check`, because a name with no body is unrunnable
     * and a body from nowhere is unattributable, and no code path should be
     * able to produce either.
     */
    skillName: text('skill_name'),
    // Deterministic WYSIWYG copy {name, description, body, metadata, origin},
    // pinned at save time so an edit to the skill cannot change what an already
    // scheduled job sends. NULL iff skill_name is NULL (see above).
    skillSnapshot: jsonb('skill_snapshot').$type<SkillSnapshot>(),
    // What the run produces, and therefore which agent runs it. The user's
    // choice on the job; was `execution`, denormalised from skill metadata,
    // until 0043.
    output: text('output').$type<JobOutput>().notNull(),
    // null = all sources available to the agent (always includes knowledge_layer).
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
    projectIdx: index('idx_jobs_project_id').on(table.projectId),
    orgIdx: index('idx_jobs_organization_id').on(table.organizationId),
    // NOTE: the partial due-scan index `idx_jobs_due` on (next_run_at) WHERE
    // schedule_cron IS NOT NULL AND enabled is a PARTIAL index the drizzle
    // builder can't express, so it lives only in migrations: created as
    // `idx_skill_schedules_due` by 0041_agent_skills.sql and renamed to its
    // current name by 0043_jobs.sql. It backs the scheduler's due-row claim.
  })
)

export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The job this run belongs to.
     *
     * Still `schedule_id` in the database, and deliberately so: 0043 renamed
     * "schedule" to "job" everywhere it could, but this table already has a
     * `job_id` meaning the backend async-job id. Two unrelated ids cannot share
     * one name, so the parent link keeps its original one — see the column
     * comments recorded by that migration.
     */
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    organizationId: text('organization_id').notNull(),
    // Backend async-job id; NULL when skipped/error. NOT a reference to jobs.id
    // — that is scheduleId above.
    jobId: text('job_id'),
    trigger: text('trigger').$type<JobRunTrigger>().notNull(),
    status: text('status').$type<JobRunStatus>().notNull(),
    // Skip reason (e.g. org job cap / feature gate) or submission error.
    detail: text('detail'),
    /**
     * Where an `output: 'chat'` run landed, once it finished — the conversation
     * the user can open and continue. NULL for deep-research runs (they produce
     * a report), for skipped/error runs, and for runs that predate 0043.
     *
     * `text`, not uuid: `conversations.id` is text. No drizzle `.references()`
     * because the real constraint is composite —
     * `(conversation_id, organization_id) -> conversations (id, organization_id)`,
     * the house pattern from 0032 — which the builder cannot express. It stops
     * a run from naming another tenant's conversation.
     */
    conversationId: text('conversation_id'),
    // The job's snapshot at fire time — runs stay self-describing. NOT NULL
    // even though jobs.skill_snapshot is nullable: a skill-less job records
    // `{}` here, so history keeps one shape to read.
    skillSnapshot: jsonb('skill_snapshot').$type<SkillSnapshot>().notNull(),
    // User id for manual runs, 'scheduler' for cron.
    triggeredBy: text('triggered_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Created via `("schedule_id","created_at" DESC)` in the SQL migration so
    // the newest-first run-history query is a plain index scan.
    jobCreatedIdx: index('idx_job_runs_job_created').on(table.scheduleId, table.createdAt),
    // The worker reports a run's outcome by the BACKEND job id (the only id it
    // holds), so that lookup needs its own index (migration 0073).
    backendJobIdx: index('idx_job_runs_backend_job_id').on(table.jobId),
    projectIdx: index('idx_job_runs_project_id').on(table.projectId),
    orgIdx: index('idx_job_runs_organization_id').on(table.organizationId),
    createdIdx: index('idx_job_runs_created_at').on(table.createdAt),
  })
)

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  project: one(projects, { fields: [jobs.projectId], references: [projects.id] }),
  runs: many(jobRuns),
}))

export const jobRunsRelations = relations(jobRuns, ({ one }) => ({
  job: one(jobs, { fields: [jobRuns.scheduleId], references: [jobs.id] }),
}))

export type Skill = typeof skills.$inferSelect
export type NewSkill = typeof skills.$inferInsert
export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
export type JobRun = typeof jobRuns.$inferSelect
export type NewJobRun = typeof jobRuns.$inferInsert
