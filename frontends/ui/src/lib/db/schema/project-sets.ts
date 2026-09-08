import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { projects } from './projects'

/**
 * `project_sets` — a **Sammlung**: a named, reusable set of projects (ADR-0054,
 * spec GR-2).
 *
 * A Bezirk, a client, a year. The office already has these sets in its head,
 * and re-picking their members out of a tree every morning is the work the Büro
 * was meant to remove. GR-2 requires the generalisation to be "one table and no
 * new mechanism", which is exactly what this is: mounting a Sammlung expands to
 * the SAME `conversation_mounts` rows a person's clicks would have written,
 * through the same service, the same per-project permission and the same cap.
 *
 * **The set is an addressing convenience, never a second kind of scope.** A
 * conversation records the projects it mounted, not the set it mounted them
 * from — so a Sammlung that gains a project tomorrow does not silently widen a
 * thread that was mounted today, and the cap keeps meaning what it meant.
 *
 * **A name is the whole of its usefulness.** `uniq_project_sets_org_name` in
 * migration 0084 is UNIQUE on `(organization_id, lower(name))` — an expression
 * index drizzle cannot express — because two "Bezirk 3"s differing in case are
 * two things nobody can tell apart, and the name is what a cap refusal says out
 * loud. A non-blank CHECK sits beside it for the same reason.
 *
 * The composite UNIQUE `(id, organization_id)` is likewise in 0084: it is what
 * gives {@link projectSetMembers}' foreign key a pair to point at, the same
 * belt-and-braces `tasks` adopted in 0075.
 */
export const projectSets = pgTable(
  'project_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /** Unique per organization, case-insensitively (0084). Never blank. */
    name: text('name').notNull(),
    description: text('description'),
    /**
     * The WorkOS user who created it — attribution, and half of the edit rule:
     * its creator may edit it, and so may anyone holding
     * `org:projects:administer` (`lib/workspace/project-sets-service.ts`).
     */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => ({
    // NOTE: the organisation's name index is UNIQUE over
    // `(organization_id, lower(name))` — an EXPRESSION index the drizzle
    // builder cannot express, so it lives in migration 0084
    // (`uniq_project_sets_org_name`) beside the non-blank CHECK and the
    // composite UNIQUE `(id, organization_id)` the membership points at.
  })
)

/**
 * `project_set_members` — which projects a Sammlung names (ADR-0054, GR-2).
 *
 * A join table rather than a `uuid[]` on the set, for the two reasons an array
 * cannot cover: a project purge must take its memberships with it, which only a
 * real foreign key does (so ADR-0011's pipeline learns nothing new), and "which
 * Sammlungen is this project in?" is a direction an array answers with a scan.
 *
 * **Both foreign keys are composite** — `(set_id, organization_id)` and
 * `(project_id, organization_id)` — and both `ON DELETE CASCADE`. Drizzle can
 * express neither, so they live in 0084. Neither reaches a conversation:
 * a mount made through a set is an ordinary mount row afterwards, so deleting
 * the Sammlung it came from changes nothing about what a thread already reads.
 */
export const projectSetMembers = pgTable(
  'project_set_members',
  {
    setId: uuid('set_id').notNull(),
    /**
     * Denormalised so RLS filters without a join — and half of both composite
     * foreign keys, which is what stops the copy from disagreeing with the set
     * or the project it names.
     */
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** One membership per (set, project): adding twice is the same membership. */
    pk: primaryKey({
      name: 'project_set_members_pkey',
      columns: [table.setId, table.projectId],
    }),
    /** The purge's and a project surface's direction of travel. */
    projectIdx: index('project_set_members_project_idx').on(table.projectId),
  })
)

export const projectSetsRelations = relations(projectSets, ({ many }) => ({
  members: many(projectSetMembers),
}))

export const projectSetMembersRelations = relations(projectSetMembers, ({ one }) => ({
  set: one(projectSets, {
    fields: [projectSetMembers.setId],
    references: [projectSets.id],
  }),
  project: one(projects, {
    fields: [projectSetMembers.projectId],
    references: [projects.id],
  }),
}))

export type ProjectSet = typeof projectSets.$inferSelect
export type NewProjectSet = typeof projectSets.$inferInsert
export type ProjectSetMember = typeof projectSetMembers.$inferSelect
export type NewProjectSetMember = typeof projectSetMembers.$inferInsert
