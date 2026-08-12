import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * The skills the PLATFORM curates for every organization (Platform → Skills).
 *
 * Global by design — no `organization_id`. One row here is offered to every
 * tenant at once, which is the whole point: we write a skill in the platform
 * dashboard and it reaches every org and project without anyone copying
 * anything. Whether a given org actually runs it is that org's decision, stored
 * separately in `curated_skill_activations`; deleting THAT row switches the
 * skill off, deleting THIS one withdraws it from the fleet.
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
