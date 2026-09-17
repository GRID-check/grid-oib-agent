/**
 * One organization's standing instruction block — the text an org admin writes
 * under Organisation → Anweisungen, sent to the agent on every turn.
 *
 * ## Why a table and not a key in `organizations.settings`
 *
 * The jsonb bag is where the other tenant-chosen settings live
 * (`webSearchEnabled`, `zdrOnly`, `llmProviderMode`, ADR-0022) and it would
 * have fitted the shape of this one. Three properties are why it is a table
 * instead, and each of them is a thing the bag cannot hold:
 *
 *   - **A bound.** The text is interpolated into a prompt on every turn, so its
 *     length is a cost and a safety property, not a preference. The bound is
 *     stated once, in SQL (`organization_instructions_length`), where it holds
 *     against a backfill, a psql session and a future writer that never read
 *     this file. A `char_length(settings->>'x')` CHECK on a schemaless bag is
 *     possible and is a constraint nobody would find.
 *   - **Attribution.** `updated_by` answers "who told the agent to do that",
 *     which is the first question anyone asks of an instruction that shaped an
 *     answer. The bag has one `updated_at` for every key it holds together.
 *   - **A read that is not the bag's read.** This value is on the WS-upgrade
 *     hot path (`X-Grid-Org-Instructions`). Its own row is its own cache entry
 *     and its own invalidation; a bag key shares both with everything else in
 *     the bag.
 *
 * ## What it is NOT
 *
 * Not policy, not a normative source. The instruction block states standing
 * preferences on FORM, FOCUS and WORKFLOW — how long an answer runs, which
 * Bundesland is usually meant, whether to lead with the verdict. It never
 * overrides Piloti's own rules and it never supplies a normative value: an OIB
 * limit comes from the norm, never from a sentence somebody typed in settings.
 * The backend states the same boundary where it renders the block; the UI says
 * it to the person writing one.
 *
 * One row per organization, keyed by the WorkOS organization id, created on
 * first save. No row means no instructions, and clearing the text deletes the
 * row rather than storing an empty string — "never written" and "written, then
 * emptied" have the same meaning here and must not be two states.
 */

import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const organizationInstructions = pgTable('organization_instructions', {
  /** WorkOS organization id — one block per organization, so it is the key. */
  organizationId: text('organization_id').primaryKey(),
  /**
   * The block itself.
   *
   * Bounded at `ORG_INSTRUCTIONS_MAX_CHARS` (`@/lib/org-instructions/constants`,
   * the one place the number is written) and never empty — both stated
   * in SQL (`organization_instructions_length`,
   * `organization_instructions_not_blank`, migration 0087), because a bound a
   * prompt depends on has to survive a backfill and a psql session, not only
   * the zod schema in front of the one route that writes it today.
   */
  instructions: text('instructions').notNull(),
  /** The admin who last wrote it — "who told the agent to do that". */
  updatedBy: text('updated_by').notNull(),
  updatedByEmail: text('updated_by_email'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type OrganizationInstructions = typeof organizationInstructions.$inferSelect
export type NewOrganizationInstructions = typeof organizationInstructions.$inferInsert
