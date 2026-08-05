import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Platform-controlled reasoning effort per agent group (migration
 * `0030_platform_reasoning_efforts.sql`, Platform → Models).
 *
 * One row per agent group (`lib/model-config/agent-groups.ts`), carrying an
 * effort from OpenRouter's unified vocabulary. Written by the platform owner;
 * read by the Python backend through `GET /api/internal/reasoning-efforts`
 * (TTL-cached, fail-open to the workflow YAML `reasoning_effort`).
 *
 * Global by design — no `organization_id`, and no org layer at all. A tenant
 * picking its own MODEL is a product feature (`org_model_config_versions`);
 * a tenant dialling its own reasoning spend is not, so this table has exactly
 * one writer. A missing row means "use the YAML value for that role".
 */
export const platformReasoningEfforts = pgTable('platform_reasoning_efforts', {
  /** Agent group id (`lib/model-config/agent-groups.ts`), e.g. `deep_research`. */
  agentGroup: text('agent_group').primaryKey(),
  /** OpenRouter unified effort: none | minimal | low | medium | high | xhigh. */
  effort: text('effort').notNull(),
  /** Optional change note from the platform owner. */
  note: text('note'),
  /** WorkOS user id of the platform owner who last wrote this row. */
  updatedBy: text('updated_by').notNull(),
  updatedByEmail: text('updated_by_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type PlatformReasoningEffort = typeof platformReasoningEfforts.$inferSelect
export type NewPlatformReasoningEffort = typeof platformReasoningEfforts.$inferInsert
