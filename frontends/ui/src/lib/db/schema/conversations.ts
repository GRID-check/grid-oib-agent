import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  createdBy: text('created_by').notNull(),
  title: text('title'),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
