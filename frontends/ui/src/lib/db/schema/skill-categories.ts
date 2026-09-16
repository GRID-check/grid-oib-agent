import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Skill categories — the categories skills stand in.
 *
 * ONE table for both curators. A NULL `organization_id` is a PLATFORM row:
 * curated once, read by every organization, written only through the platform
 * dashboard. A set `organization_id` is that org's own category for the skills
 * it authors itself. The split is one nullable column rather than two tables
 * because the UI reads them as one list (platform skill categories first, then
 * the org's own), and two tables would need every read, write and validation
 * to exist twice for no additional safety — the tenant boundary already
 * distinguishes them (see 0089's predicate: platform rows are readable by all,
 * writable through the platform role's service checks).
 *
 * Names are unique per category owner: platform names among platform rows, org
 * names within the org. Postgres treats NULLs as distinct, so one plain
 * UNIQUE would let two platform skill categories share a name — hence the two partial
 * indexes below.
 */
export const skillCategories = pgTable(
  'skill_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NULL = platform-owned (global); otherwise the owning organization. */
    organizationId: text('organization_id'),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * Stable key for the categories the platform seeds from the builtin
     * collections (`oib`, `research`, …). Builtin FILE offers have no row to
     * store a category on, so they resolve to a category by this key — a display
     * NAME the owner renames must never detach them. NULL for org categories and
     * for platform skill categories no collection resolves to: files never attach
     * there, dashboard rows go anywhere.
     */
    slug: text('slug'),
    /** Display order within one owner's categories; ties break by name. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdByEmail: text('created_by_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platformNameIdx: uniqueIndex('idx_skill_categories_platform_name')
      .on(table.name)
      .where(sql`${table.organizationId} IS NULL`),
    orgNameIdx: uniqueIndex('idx_skill_categories_org_name')
      .on(table.organizationId, table.name)
      .where(sql`${table.organizationId} IS NOT NULL`),
    platformSlugIdx: uniqueIndex('idx_skill_categories_platform_slug')
      .on(table.slug)
      .where(sql`${table.organizationId} IS NULL AND ${table.slug} IS NOT NULL`),
    orgIdx: index('idx_skill_categories_organization_id').on(table.organizationId),
  })
)

export type SkillCategoryRow = typeof skillCategories.$inferSelect
export type NewSkillCategoryRow = typeof skillCategories.$inferInsert
