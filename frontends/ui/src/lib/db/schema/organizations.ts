import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Grid-side organization record.
 *
 * WorkOS remains the source of truth for org identity and membership; this
 * table stores the Grid-specific settings and cached display fields that WorkOS
 * doesn't model, keyed by the WorkOS organization id. It lets us:
 *   - render org context without a WorkOS round-trip on every request,
 *   - hold org-level product settings (default language for new members, a
 *     display-name override, document-retention defaults, …),
 *   - attach future org-scoped data via the `settings` jsonb without a schema
 *     change each time.
 *
 * Rows are created lazily (upserted) the first time an org's settings are read
 * or written — we never need a backfill.
 */
export const organizations = pgTable('organizations', {
  /** WorkOS organization id (e.g. `org_...`). */
  workosOrganizationId: text('workos_organization_id').primaryKey(),
  /** Optional Grid display-name override; falls back to the WorkOS org name. */
  displayName: text('display_name'),
  /** Default interface language applied to new members / unset users. */
  defaultLocale: text('default_locale').notNull().default('en'),
  /** Flexible bag for additional org-scoped settings. */
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Organization = typeof organizations.$inferSelect
export type NewOrganization = typeof organizations.$inferInsert
