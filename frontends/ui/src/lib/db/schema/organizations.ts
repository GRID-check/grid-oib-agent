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

/**
 * Keys in the `settings` bag that belong to the PLATFORM OPERATOR, not the
 * tenant.
 *
 * The bag has one write path and no schema, so before this list the owner of a
 * key was expressed only by which service function a caller happened to reach
 * for. `setStorageQuota` is platform-only by construction — explicit
 * `organizationId`, a refusal below current usage, `requirePlatformOwner` on the
 * route — and every bit of that was bypassable through
 * `PUT /api/organization/settings`, which merges arbitrary keys under
 * `org:settings:manage`, a permission tenant admins hold. A tenant could raise
 * its own quota, which makes it not a quota.
 *
 * Declared here, beside the column, because this is the file anyone adding a
 * setting reads. Enforced in `updateOrgSettings` — the merge every writer passes
 * through — rather than in the route, so a new tenant-facing endpoint inherits
 * the guard instead of having to remember it.
 *
 * A key belongs here when the tenant is the party the value CONSTRAINS. A
 * setting the tenant chooses for itself (`zdrOnly`, `webSearchEnabled`,
 * `providerMode`) does not, however sensitive.
 */
export const PLATFORM_OWNED_SETTINGS = ['storageQuotaBytes'] as const

export type PlatformOwnedSetting = (typeof PLATFORM_OWNED_SETTINGS)[number]
