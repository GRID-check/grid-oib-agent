import { sql } from 'drizzle-orm'
import { check, date, foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { projects } from './projects'

/**
 * Everyone who worked on a project, with or without a Piloti account
 * (migration 0115, ADR-0083): former staff, external planners, the client's
 * people. The Steckbrief's people list.
 *
 * Personal data of people who mostly never gave it: name, function, company,
 * months, and an optional link to a Piloti account, nothing else (no e-mail, no
 * phone). Deleted outright, never soft-deleted: deleting is the erasure. Never
 * part of the agent's prompt.
 */
export const projectPeople = pgTable(
  'project_people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    /** Funktion: what they did on the project (Projektleitung, Statik, Bauherr). */
    function: text('function'),
    /** Firma. */
    company: text('company'),
    /** From, month precision: the first of its month. */
    startedOn: date('started_on', { mode: 'string' }),
    /** To, month precision: the first of its month. */
    endedOn: date('ended_on', { mode: 'string' }),
    /** The WorkOS user id of their Piloti account, when they have one and someone linked it. */
    userId: text('user_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectFk: foreignKey({
      name: 'project_people_project_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
    projectIdx: index('project_people_project_idx').on(table.organizationId, table.projectId, table.name),
    nameLength: check('project_people_name_length', sql`char_length(btrim(${table.name})) BETWEEN 1 AND 200`),
    functionLength: check('project_people_function_length', sql`${table.function} IS NULL OR char_length(${table.function}) <= 200`),
    companyLength: check('project_people_company_length', sql`${table.company} IS NULL OR char_length(${table.company}) <= 200`),
    periodCheck: check(
      'project_people_period_check',
      sql`(${table.startedOn} IS NULL OR extract(day FROM ${table.startedOn}) = 1) AND (${table.endedOn} IS NULL OR extract(day FROM ${table.endedOn}) = 1) AND (${table.startedOn} IS NULL OR ${table.endedOn} IS NULL OR ${table.endedOn} >= ${table.startedOn})`
    ),
  })
)

export type ProjectPersonRow = typeof projectPeople.$inferSelect
export type NewProjectPersonRow = typeof projectPeople.$inferInsert
