/**
 * The research plan: what a deep research is about, as one row every tier
 * reads (migration 0092, ADR-0068).
 *
 * The wire shape and the vocabularies are `lib/plans/plan-types.ts`; this
 * file is the storage of the same thing. The CHECKs are derived from those
 * tuples so the column and the contract cannot disagree.
 */

import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { PlanDocument } from '@/lib/runs/plan-documents'
import {
  PLAN_AUTHORS,
  PLAN_DEPTHS,
  PLAN_GENRES,
  PLAN_STATUSES,
  type PlanAuthor,
  type PlanDepth,
  type PlanGenre,
  type PlanStatus,
} from '@/lib/plans/plan-types'
import { projects } from './projects'

const known = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `)

export const researchPlans = pgTable(
  'research_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The thread the plan was proposed in; null for a plan written outside one. */
    conversationId: text('conversation_id'),
    /** The run this plan was commissioned into. No FK: the plan outlives the run. */
    runId: text('run_id'),
    author: text('author').$type<PlanAuthor>().notNull(),
    status: text('status').$type<PlanStatus>().notNull().default('proposed'),
    question: text('question').notNull(),
    title: text('title').notNull(),
    sections: jsonb('sections').$type<string[]>().notNull(),
    genre: text('genre').$type<PlanGenre>().notNull().default('bericht'),
    depth: text('depth').$type<PlanDepth>().notNull().default('gutachten'),
    grundlage: jsonb('grundlage').$type<PlanDocument[]>().notNull().default([]),
    ausgeschlossen: jsonb('ausgeschlossen').$type<PlanDocument[]>().notNull().default([]),
    /** „Nur diese": the reader's own documents are confined to the Grundlage (migration 0093). */
    nurGrundlage: boolean('nur_grundlage').notNull().default(false),
    dataSources: jsonb('data_sources').$type<string[]>(),
    unterlagen: jsonb('unterlagen').$type<PlanDocument[]>().notNull().default([]),
    /** When a proposed plan may start on its own; null while it waits for a person. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    heldAt: timestamp('held_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectCreatedIdx: index('idx_research_plans_project_created').on(table.projectId, table.createdAt),
    organizationIdx: index('idx_research_plans_organization_id').on(table.organizationId),
    // `idx_research_plans_run_id` is partial (WHERE run_id IS NOT NULL) and
    // lives only in the migration: drizzle's builder cannot express it.
    statusKnown: check('research_plans_status_known', sql`${table.status} IN (${known(PLAN_STATUSES)})`),
    authorKnown: check('research_plans_author_known', sql`${table.author} IN (${known(PLAN_AUTHORS)})`),
    genreKnown: check('research_plans_genre_known', sql`${table.genre} IN (${known(PLAN_GENRES)})`),
    depthKnown: check('research_plans_depth_known', sql`${table.depth} IN (${known(PLAN_DEPTHS)})`),
    nurHasGrundlage: check(
      'research_plans_nur_has_grundlage',
      sql`NOT ${table.nurGrundlage} OR jsonb_array_length(${table.grundlage}) > 0`
    ),
    heldHasNoClock: check(
      'research_plans_held_has_no_clock',
      sql`${table.status} <> 'held' OR ${table.startsAt} IS NULL`
    ),
  })
)

export type ResearchPlanRow = typeof researchPlans.$inferSelect
export type NewResearchPlanRow = typeof researchPlans.$inferInsert
