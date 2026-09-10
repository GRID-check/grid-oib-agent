import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { conversations } from './conversations'
import { projects } from './projects'

/**
 * Who brought a project into a conversation (ADR-0054, spec MT-5).
 *
 * Two members, and the set is closed by a CHECK in migration 0083 rather than
 * by this tuple alone — a third actor is a migration, because the second CHECK
 * ties the actor to `mounted_by_user_id` and any new member would have to say
 * what it does with that column.
 */
export const MOUNT_ACTORS = ['user', 'agent'] as const
export type MountActor = (typeof MOUNT_ACTORS)[number]

/**
 * `conversation_mounts` — which projects a Büro conversation currently reads
 * (ADR-0054, spec MT-5, MT-7, MT-13…MT-15).
 *
 * A workspace turn has no project by construction, and mounting is how a
 * bounded number of project corpora join its retrieval scope. The mount is a
 * property of the CONVERSATION, not of the person who made it (MT-14): everyone
 * who can read the thread sees the same "Im Blick" set and the same provenance
 * for its answers, and the next WebSocket upgrade rebuilds the scope from these
 * rows — re-authorizing each one, which is what makes a revoked permission
 * narrow the scope rather than linger (MT-7).
 *
 * **Both foreign keys are composite** (`(conversation_id, organization_id)` and
 * `(project_id, organization_id)`), the belt-and-braces `tasks` adopted in 0075.
 * Drizzle cannot express either, so they live in migration 0083 beside the
 * CHECKs. They are what makes a mount tying one tenant's conversation to
 * another tenant's project unwritable, rather than merely unwritten.
 *
 * **A project purge takes its mounts and stops** (MT-15, ADR-0011). The
 * `ON DELETE CASCADE` on the project key is the whole of that story, and the
 * deletion pipeline needs no new step; the conversation belongs to the
 * organization and survives, which is why nothing here cascades the other way.
 */
export const conversationMounts = pgTable(
  'conversation_mounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    /**
     * Denormalised so RLS filters without a join — and half of both composite
     * foreign keys, which is what stops the copy from disagreeing with the
     * conversation and the project it names.
     */
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    /**
     * `user` or `agent` — a person chose the project in the scope tree, or
     * `open_project` mounted it mid-turn (MT-2: both go through one endpoint,
     * so this column is the only thing that tells them apart afterwards).
     */
    mountedBy: text('mounted_by').$type<MountActor>().notNull(),
    /**
     * The person, when a person did it; NULL for the agent. Tied to
     * `mounted_by` by a biconditional CHECK in 0083, so a half-filled row — an
     * agent mount carrying a user id, a user mount carrying none — cannot be
     * written and the attribution the UI renders is never a guess.
     */
    mountedByUserId: text('mounted_by_user_id'),
    mountedAt: timestamp('mounted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * One mount per (conversation, project). This is what makes re-mounting
     * idempotent and what stops the cap being consumed twice by the same
     * project: the service inserts on conflict do nothing and reads the
     * existing row back.
     */
    conversationProjectKey: uniqueIndex('uniq_conversation_mounts').on(
      table.conversationId,
      table.projectId
    ),
    /** The purge's and the project surface's direction of travel. */
    projectIdx: index('conversation_mounts_project_idx').on(table.projectId),
  })
)

export const conversationMountsRelations = relations(conversationMounts, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationMounts.conversationId],
    references: [conversations.id],
  }),
  project: one(projects, {
    fields: [conversationMounts.projectId],
    references: [projects.id],
  }),
}))

export type ConversationMount = typeof conversationMounts.$inferSelect
export type NewConversationMount = typeof conversationMounts.$inferInsert
