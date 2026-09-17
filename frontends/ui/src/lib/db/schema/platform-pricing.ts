import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * The platform's price list (migration `0079_pricing_and_credits.sql`,
 * ADR-0053, Platform → Overview → Pricing).
 *
 * Two numbers turn a generation's raw OpenRouter cost into what the tenant
 * sees, both linear, no currency conversion — USD is what OpenRouter charges:
 *
 *   price_usd = cost_usd × marginMultiplier   (margin 1 for BYOK)
 *   credits   = price_usd ÷ usdPerCredit
 *
 * Plus the allowance an organization is seeded with until its admins set
 * explicit limits. One row, because they are one decision.
 *
 * Append-only with the supersede idiom: a change writes a new `active` row and
 * marks the old one `superseded`, so every ledger row can name the version that
 * priced it (`llm_usage_events.pricing_version_id`). At most one active row
 * (partial unique index in the migration). An EMPTY table means the boot floor
 * applies — see `lib/pricing/service.ts`.
 *
 * Global by design — no `organization_id`. A PLATFORM table for the tenant
 * boundary: every tenant reads, only the platform role writes.
 */

export const PRICING_VERSION_STATUSES = ['active', 'superseded'] as const
export type PricingVersionStatus = (typeof PRICING_VERSION_STATUSES)[number]

export const platformPricingVersions = pgTable('platform_pricing_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Price ÷ cost. 1 = pass-through. */
  marginMultiplier: numeric('margin_multiplier', { precision: 8, scale: 4 }).notNull(),
  /** USD of price one credit stands for. */
  usdPerCredit: numeric('usd_per_credit', { precision: 10, scale: 6 }).notNull(),
  /** Seeded org allowance per window; NULL = unlimited by default. */
  defaultOrgDailyCredits: numeric('default_org_daily_credits', { precision: 14, scale: 4 }),
  defaultOrgMonthlyCredits: numeric('default_org_monthly_credits', { precision: 14, scale: 4 }),
  status: text('status').$type<PricingVersionStatus>().notNull().default('active'),
  supersedesId: uuid('supersedes_id'),
  note: text('note'),
  /** WorkOS user id of the platform owner who wrote this version. */
  createdBy: text('created_by').notNull(),
  createdByEmail: text('created_by_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type PlatformPricingVersion = typeof platformPricingVersions.$inferSelect
export type NewPlatformPricingVersion = typeof platformPricingVersions.$inferInsert
