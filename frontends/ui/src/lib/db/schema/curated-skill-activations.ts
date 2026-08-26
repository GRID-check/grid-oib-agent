/**
 * An organization's decision about a platform-CURATED skill: on, or off.
 *
 * Platform skills are files, not rows — they ship under
 * `src/aiq_agent/skills/builtin/<collection>/` and reach the BFF through the
 * generated `@/lib/skills/platform-skills` module. There are two kinds, and
 * only one of them has anything to do with this table:
 *
 *   internal   The pipeline's own machinery. Not an organization's business:
 *              never listed, never switchable, always resolved. A skill that
 *              says nothing is machinery.
 *
 *   curated    A capability we publish TO organizations (`grid-catalog:
 *              curated`). Offered on the Skills tab. That decision is this
 *              table.
 *
 * One row per (organization, curated skill it has decided about). No row means
 * the default: a chat-usable FILE starts ON, a dashboard offer or a
 * deep-research-only file starts OFF. The org can still switch either way.
 *
 * Deliberately NOT a `skills` row. A skills row carries a body, and a body is a
 * copy — it would drift from the file it came from the first time we improved
 * the skill, leaving the org running an old instruction nobody there wrote.
 * That was exactly the flaw in the "clone a platform skill" flow this replaces.
 * What is stored here is only the decision.
 *
 * `skill_name` is plain text, not a foreign key: its referent is a file in the
 * repository. A row naming a skill that no longer ships is inert — nothing
 * resolves it — and the decision survives if that skill ever comes back.
 */

import { boolean, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const curatedSkillActivations = pgTable(
  'curated_skill_activations',
  {
    organizationId: text('organization_id').notNull(),
    /** The platform skill's `name` — the token people type after a slash. */
    skillName: text('skill_name').notNull(),
    /**
     * The decision itself.
     *
     * A column rather than the row's mere presence, so switching something back
     * OFF reads as a decision in the data instead of as the absence of one —
     * and so `updated_by` below means something in both directions.
     */
    enabled: boolean('enabled').notNull().default(false),
    updatedBy: text('updated_by').notNull(),
    updatedByEmail: text('updated_by_email'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organizationId, table.skillName] }),
    orgIdx: index('idx_curated_skill_activations_organization_id').on(table.organizationId),
  })
)

export type CuratedSkillActivation = typeof curatedSkillActivations.$inferSelect
export type NewCuratedSkillActivation = typeof curatedSkillActivations.$inferInsert
