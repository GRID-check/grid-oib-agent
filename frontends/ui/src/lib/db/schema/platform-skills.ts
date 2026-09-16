import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { skillCategories } from './skill-categories'

/**
 * How a curated skill reaches organizations. One answer since migration 0088:
 * it is OFFERED.
 *
 * There used to be a second, `standard` — fleet standard equipment, resolved
 * for every organization with no decision in it, and FORCED onto every run so
 * its body loaded whether or not the model judged it relevant. It is gone,
 * together with the other way a skill could be forced onto a turn (the
 * composer's `skills` array on the WS envelope). Both answered "how should
 * Piloti behave by default?" with the wrong mechanism: a skill is a capability
 * the model may reach for, and a skill that is always forced is an instruction
 * wearing a capability's clothes.
 *
 * Standing instructions have two homes now, and neither is this table: the
 * PLATFORM PROMPT for what the platform says, and `organization_instructions`
 * (migration 0087) for what a tenant says.
 *
 * The tuple survives with one member rather than the column being dropped,
 * because the column still states something true — a curated skill is offered —
 * and `platform_skills_delivery_check` still says so in SQL. A column with one
 * legal value and no constraint is a column that accepts the next typo.
 */
export const PLATFORM_SKILL_DELIVERIES = ['offer'] as const
export type PlatformSkillDelivery = (typeof PLATFORM_SKILL_DELIVERIES)[number]

/**
 * The skills the PLATFORM writes for every organization (Platform → Skills).
 *
 * Global by design — no `organization_id`. One row here reaches every tenant at
 * once, which is the whole point: we write a skill in the platform dashboard and
 * it reaches every org and project without anyone copying anything.
 *
 * What it reaches them AS is an offer: listed on every organization's Skills
 * tab, off until that org switches it on. The decision is theirs and lives in
 * `curated_skill_activations`. Chat-usable FILE offers are a different source
 * and start on.
 *
 * Distinct from the two skill sources that already existed:
 *
 *   builtin files   `src/aiq_agent/skills/builtin/**`. The deep-research
 *                   pipeline's own machinery — never listed, never switchable,
 *                   always resolved. Not an offer and not curation.
 *   `skills`        Org-authored rows, one tenant each.
 *
 * The body lives here and ONLY here. That is the difference from the "clone a
 * platform skill" flow this replaces, which copied the instruction into each
 * tenant and left every copy frozen at the moment it was taken.
 */
export const platformSkills = pgTable(
  'platform_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The agentskills.io name — what somebody types after a slash in chat.
     * Unique fleet-wide: it is the key an organization's activation decision
     * refers to, and two curated skills sharing one would make that decision
     * ambiguous.
     */
    name: text('name').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull(),
    /** Frontmatter `metadata` — the reserved keys are `grid-agents`, `grid-cards`. */
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    /**
     * Whether organizations can see this skill at all.
     *
     * A draft is invisible to every tenant, which is what makes the platform
     * dashboard usable as a writing surface: a half-written instruction that
     * appeared in every org's Skills tab the moment it was saved would force
     * every edit to be a single perfect commit.
     *
     * Withdrawing a published skill hides the offer; an org that had switched
     * it on stops resolving it, and its activation row is kept, so re-publishing
     * restores the fleet exactly as it was.
     */
    published: boolean('published').notNull().default(false),
    /**
     * How the skill reaches organizations. `offer`, and only `offer`, since
     * 0088 retired the `standard` tier — see {@link PLATFORM_SKILL_DELIVERIES}.
     *
     * A tenant can never write this column: `platform_skills` is secured with
     * `grid_secure_platform_table`, so SELECT is all the tenant role has.
     */
    delivery: text('delivery').$type<PlatformSkillDelivery>().notNull().default('offer'),
    /**
     * The platform shelf this skill stands on — a platform-owned category, or
     * NULL for unsorted. Tenant shelves are never addressable here: the
     * service validates the category's ownership on write.
     */
    categoryId: uuid('category_id').references(() => skillCategories.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by').notNull(),
    createdByEmail: text('created_by_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex('idx_platform_skills_name').on(table.name),
  })
)

export type PlatformSkillRow = typeof platformSkills.$inferSelect
export type NewPlatformSkillRow = typeof platformSkills.$inferInsert
