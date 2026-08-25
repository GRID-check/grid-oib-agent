import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export type DeletionEntityType = 'project' | 'document' | 'conversation' | 'organization' | 'user'

export type DeletionStatus = 'pending' | 'purging' | 'purged' | 'restored' | 'failed'

export const deletionQueue = pgTable('deletion_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: text('entity_type').$type<DeletionEntityType>().notNull(),
  entityId: text('entity_id').notNull(),
  displayName: text('display_name').notNull(),
  organizationId: text('organization_id').notNull(),
  requestedBy: text('requested_by').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  purgedAt: timestamp('purged_at', { withTimezone: true }),
  status: text('status').$type<DeletionStatus>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
})

export type DeletionQueueEntry = typeof deletionQueue.$inferSelect
export type NewDeletionQueueEntry = typeof deletionQueue.$inferInsert
