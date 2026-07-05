import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import type { DeletionEntityType } from './deletion-queue'

export const legalHolds = pgTable('legal_holds', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: text('entity_type').$type<DeletionEntityType>().notNull(),
  entityId: text('entity_id').notNull(),
  organizationId: text('organization_id').notNull(),
  reason: text('reason').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
})

export type LegalHold = typeof legalHolds.$inferSelect
export type NewLegalHold = typeof legalHolds.$inferInsert
