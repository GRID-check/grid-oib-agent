import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * How a curated skill reaches organizations.
 *
 * `offer` is the default and what 0047 shipped: publishing puts the skill on
 * every org's Skills tab, and each one decides. `standard` is the tier that has
 * no tenant decision in it at all — the platform's own house instruction, live
 * for the whole fleet the moment it is published.
 *
 * Mirrored by the `platform_skills_delivery_check` constraint (0050), which is
 * the one that survives a psql session: the resolver asks `delivery ===
 * 'standard'`, so an unrecognised value fails toward "offer" and would silently
 * demote a fleet instruction to something nobody was told to switch on.
 */
export const PLATFORM_SKILL_DELIVERIES = ['offer', 'standard'] as const
export type PlatformSkillDelivery = (typeof PLATFORM_SKILL_DELIVERIES)[number]

/**
 * The skills the PLATFORM writes for every organization (Platform → Skills).
 *
 * Global by design — no `organization_id`. One row here reaches every tenant at
 * once, which is the whole point: we write a skill in the platform dashboard and
 * it reaches every org and project without anyone copying anything.
 *
 * HOW it reaches them is `delivery`, and there are two answers:
 *
 *   'offer'     Listed on every organization's Skills tab. A dashboard offer
 *               starts off until that org switches it on. The decision is
 *               theirs and lives in `curated_skill_activations`. Chat-usable
 *               FILE offers are a different source and start on.
 *   'standard'  Fleet standard equipment. Resolved for every organization with
 *               no decision to make, never listed, not switchable, and not
 *               shadowable by an org row of the same name.
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
     * Whether organizations CHOOSE this skill or simply run it.
     *
     * Orthogonal to `published`, and the two closed defaults mean different
     * things: an unpublished row is invisible, an `offer` row requires consent.
     * A published `standard` row is the only combination that imposes anything
     * on a tenant, which is why it takes two deliberate acts to reach.
     *
     * A tenant can never write this column — `platform_skills` is secured with
     * `grid_secure_platform_table`, so SELECT is all the tenant role has. That
     * is what makes `standard` an enforced boundary rather than a convention an
     * org could route around by crafting a request.
     */
    delivery: text('delivery')
      .$type<PlatformSkillDelivery>()
      .notNull()
      .default('offer'),
    createdBy: text('created_by').notNull(),
    createdByEmail: text('created_by_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex('idx_platform_skills_name').on(table.name),
  }),
)

export type PlatformSkillRow = typeof platformSkills.$inferSelect
export type NewPlatformSkillRow = typeof platformSkills.$inferInsert
