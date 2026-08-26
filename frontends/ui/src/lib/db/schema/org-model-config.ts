import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Org-level runtime model configuration (ADR-0014,
 * docs/architecture/org-model-configuration.md).
 *
 * Two tables:
 *  - `org_model_configs` — one row per org: which configuration version is
 *    live right now (the pointer). Rollback = repoint, nothing is rewritten.
 *  - `org_model_config_versions` — immutable, append-only history. Every save
 *    creates a new version carrying the full overrides object, who created
 *    it, and a snapshot of the OpenRouter catalog metadata the models were
 *    validated against (auditability: what did the admin see when they chose
 *    this model?).
 *
 * `organization_id` is the WorkOS org id (text, never an FK — WorkOS is the
 * source of truth for org identity, see ADR-0007).
 */

export const orgModelConfigs = pgTable('org_model_configs', {
  /** WorkOS organization id (e.g. `org_...`). */
  organizationId: text('organization_id').primaryKey(),
  /** Currently active version; NULL = no overrides, workflow YAML defaults apply. */
  activeVersionId: uuid('active_version_id').references(() => orgModelConfigVersions.id),
  /** WorkOS user id of the admin who last (de)activated a version. */
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const orgModelConfigVersions = pgTable(
  'org_model_config_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /** Monotonic per-org version number (1, 2, 3, …). */
    version: integer('version').notNull(),
    /**
     * The configuration payload: `{ [agentGroupId]: { model: string } }`.
     * Only known agent-group ids (see lib/model-config/agent-groups.ts) with
     * catalog-validated OpenRouter model ids are ever written.
     */
    overrides: jsonb('overrides').notNull().default({}),
    /**
     * OpenRouter catalog metadata for each chosen model at validation time
     * (id, name, context length, pricing, supported parameters). Pure audit
     * trail — never re-applied.
     */
    modelSnapshot: jsonb('model_snapshot'),
    /** Optional admin-supplied change note. */
    comment: text('comment'),
    /** WorkOS user id of the admin who created this version. */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgVersionUnique: uniqueIndex('uniq_org_model_config_versions_org_version').on(
      table.organizationId,
      table.version
    ),
    orgIdx: index('idx_org_model_config_versions_org').on(table.organizationId, table.createdAt),
  })
)

export type OrgModelConfig = typeof orgModelConfigs.$inferSelect
export type OrgModelConfigVersion = typeof orgModelConfigVersions.$inferSelect
export type NewOrgModelConfigVersion = typeof orgModelConfigVersions.$inferInsert
