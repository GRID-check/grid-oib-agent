import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Platform-controlled retrieval counts (migration
 * `0029_platform_retrieval_settings.sql`, Platform → Retrieval).
 *
 * One row per tunable retrieval count (`lib/retrieval-settings/catalog.ts`),
 * e.g. `knowledge.top_k` or `ris.max_results`. Written by the platform owner;
 * read by the Python backend through `GET /api/internal/retrieval-settings`
 * (TTL-cached, fail-open to the workflow YAML / tool-constant defaults).
 *
 * Global by design — no `organization_id`. Retrieval depth is a fleet-wide
 * quality/cost trade-off, not a tenant preference. A missing row means "use
 * the boot default", so deleting a row returns that count to the YAML value.
 */
export const platformRetrievalSettings = pgTable('platform_retrieval_settings', {
  /** Catalog setting key, e.g. `knowledge.top_k`. */
  key: text('key').primaryKey(),
  /** The chosen count, catalog-validated before it is written. */
  value: integer('value').notNull(),
  /** Optional change note from the platform owner. */
  note: text('note'),
  /** WorkOS user id of the platform owner who last wrote this row. */
  updatedBy: text('updated_by').notNull(),
  updatedByEmail: text('updated_by_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type PlatformRetrievalSetting = typeof platformRetrievalSettings.$inferSelect
export type NewPlatformRetrievalSetting = typeof platformRetrievalSettings.$inferInsert
