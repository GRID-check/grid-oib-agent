import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Platform-controlled default model per agent group (migration
 * `0026_platform_model_defaults.sql`, docs/architecture/org-model-configuration.md).
 *
 * The bottom layer of the three-layer model resolution:
 *
 *   org override (`org_model_config_versions`)   ← a tenant's own choice, wins
 *   platform default (this table)                ← the admin-controlled fleet default
 *   workflow YAML `model_name`                   ← boot fallback only
 *
 * Global by design — no `organization_id`. A row here changes the model for
 * every organization that has not overridden that group, which is the point:
 * moving the fleet to a newer model is one save, not a redeploy.
 */
export const platformModelDefaults = pgTable('platform_model_defaults', {
  /** Agent group id (`lib/model-config/agent-groups.ts`), e.g. `shallow_research`. */
  agentGroup: text('agent_group').primaryKey(),
  /** Catalog-validated model id the group defaults to. */
  model: text('model').notNull(),
  /**
   * Catalog metadata at save time plus `_zdr.safe` (does the model have a
   * Zero-Data-Retention endpoint?). Audit only — never re-applied at runtime.
   */
  modelSnapshot: jsonb('model_snapshot'),
  /** Optional change note from the platform owner. */
  note: text('note'),
  /** WorkOS user id of the platform owner who last wrote this row. */
  updatedBy: text('updated_by').notNull(),
  updatedByEmail: text('updated_by_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type PlatformModelDefault = typeof platformModelDefaults.$inferSelect
export type NewPlatformModelDefault = typeof platformModelDefaults.$inferInsert
