import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { projects } from './projects'
import type { SkillSnapshot } from '@/lib/skills/types'

/**
 * Agent Skills (docs/architecture/agent-skills.md) — the org toolbox of
 * agentskills.io-format skills, project-scoped schedules that fire one named
 * skill (manually or on a 5-field cron), and the submission history.
 *
 * `skill_schedules` snapshots the skill at save time (`skill_snapshot`), so a
 * run is a deterministic copy that cannot drift when the skill is later
 * edited — the workflows "compiled prompt" contract, mirrored as JSONB.
 * `skill_runs` carries its own copy of the snapshot, so run history stays
 * self-describing.
 *
 * Platform-authored skills are NOT rows here: they ship as files under
 * `src/aiq_agent/skills/builtin/<collection>/` and arrive via the generated
 * `@/lib/skills/platform-skills` module. This table holds org-authored (and
 * cloned) skills only.
 */

export const SKILL_ORIGINS = ['org', 'platform-clone'] as const
export type SkillOrigin = (typeof SKILL_ORIGINS)[number]

export const SKILL_EXECUTIONS = ['chat', 'deep-research'] as const
export type SkillExecution = (typeof SKILL_EXECUTIONS)[number]

export const SKILL_RUN_TRIGGERS = ['manual', 'schedule'] as const
export type SkillRunTrigger = (typeof SKILL_RUN_TRIGGERS)[number]

export const SKILL_RUN_STATUSES = ['submitted', 'skipped', 'error'] as const
export type SkillRunStatus = (typeof SKILL_RUN_STATUSES)[number]

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
    // Reserved keys read at fire time: grid-execution, grid-schedulable,
    // grid-agents (see lib/skills/types.ts).
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
  }),
)

export const skillSchedules = pgTable(
  'skill_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    skillName: text('skill_name').notNull(),
    // Deterministic WYSIWYG copy {name, description, body, metadata, origin}.
    skillSnapshot: jsonb('skill_snapshot').$type<SkillSnapshot>().notNull(),
    // Denormalized at save time from skill_snapshot.metadata['grid-execution'].
    execution: text('execution').$type<SkillExecution>().notNull(),
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
    projectIdx: index('idx_skill_schedules_project_id').on(table.projectId),
    orgIdx: index('idx_skill_schedules_organization_id').on(table.organizationId),
    // NOTE: the partial due-scan index `idx_skill_schedules_due` on
    // (next_run_at) WHERE schedule_cron IS NOT NULL AND enabled is a PARTIAL
    // index the drizzle builder can't express, so it lives in migration
    // 0034_skills.sql. It backs the scheduler's due-row claim.
  }),
)

export const skillRuns = pgTable(
  'skill_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => skillSchedules.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    organizationId: text('organization_id').notNull(),
    // Backend async-job id; NULL when skipped/error.
    jobId: text('job_id'),
    trigger: text('trigger').$type<SkillRunTrigger>().notNull(),
    status: text('status').$type<SkillRunStatus>().notNull(),
    // Skip reason (e.g. org job cap / feature gate) or submission error.
    detail: text('detail'),
    // The schedule's snapshot at fire time — runs stay self-describing.
    skillSnapshot: jsonb('skill_snapshot').$type<SkillSnapshot>().notNull(),
    // User id for manual runs, 'scheduler' for cron.
    triggeredBy: text('triggered_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Created via `("schedule_id","created_at" DESC)` in the SQL migration so
    // the newest-first run-history query is a plain index scan.
    scheduleCreatedIdx: index('idx_skill_runs_schedule_created').on(table.scheduleId, table.createdAt),
    projectIdx: index('idx_skill_runs_project_id').on(table.projectId),
    orgIdx: index('idx_skill_runs_organization_id').on(table.organizationId),
    createdIdx: index('idx_skill_runs_created_at').on(table.createdAt),
  }),
)

export const skillSchedulesRelations = relations(skillSchedules, ({ one, many }) => ({
  project: one(projects, { fields: [skillSchedules.projectId], references: [projects.id] }),
  runs: many(skillRuns),
}))

export const skillRunsRelations = relations(skillRuns, ({ one }) => ({
  schedule: one(skillSchedules, { fields: [skillRuns.scheduleId], references: [skillSchedules.id] }),
}))

export type Skill = typeof skills.$inferSelect
export type NewSkill = typeof skills.$inferInsert
export type SkillSchedule = typeof skillSchedules.$inferSelect
export type NewSkillSchedule = typeof skillSchedules.$inferInsert
export type SkillRun = typeof skillRuns.$inferSelect
export type NewSkillRun = typeof skillRuns.$inferInsert