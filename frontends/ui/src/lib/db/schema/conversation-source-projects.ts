import { check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * `conversation_source_projects` — another project whose content this
 * conversation drew on through a cross-project lookup (ADR-0093, migration
 * 0125). The project's restricted folders are recorded beside it, by folder id,
 * in `conversation_restricted_folders`; this row covers what every member of
 * that project reads, the root included.
 *
 * Who may read the conversation is decided at READ time: only a person who may
 * open every recorded project now (`lib/conversations/restricted-use.ts`).
 * Written only by `admitCrossProjectUse`, under the per-conversation lock every
 * widening takes. No foreign keys, for the reasons 0112 gives.
 */
export const conversationSourceProjects = pgTable(
  'conversation_source_projects',
  {
    organizationId: text('organization_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    projectId: uuid('project_id').notNull(),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'conversation_source_projects_pk',
      columns: [table.organizationId, table.conversationId, table.projectId],
    }),
    order: check('conversation_source_projects_order', sql`${table.lastAt} >= ${table.firstAt}`),
  })
)

export type ConversationSourceProject = typeof conversationSourceProjects.$inferSelect
