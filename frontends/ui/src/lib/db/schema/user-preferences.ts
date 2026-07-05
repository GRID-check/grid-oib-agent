import { jsonb, pgTable, text } from 'drizzle-orm/pg-core'

export const userPreferences = pgTable('user_preferences', {
  workosUserId: text('workos_user_id').primaryKey(),
  prefs: jsonb('prefs').notNull().default({}),
})

export type UserPreferences = typeof userPreferences.$inferSelect
export type NewUserPreferences = typeof userPreferences.$inferInsert
