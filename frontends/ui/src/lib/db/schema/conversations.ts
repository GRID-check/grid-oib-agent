import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { taskDefinitions } from './task-model'
import { projects } from './projects'
import { type ResourceVisibility, type ShareableResourceType } from './resource-shares'

/**
 * Engagement modes (ADR-0036). Deliberately two values, both meaning something a
 * user can state in one sentence. There is no `auto` — "was this message for me?"
 * is a question about conversation structure, which we hold exactly, and a model
 * asked it measures near chance (arXiv:2501.16643).
 */
export const CONVERSATION_ENGAGEMENTS = ['ask', 'mention'] as const
export type ConversationEngagement = (typeof CONVERSATION_ENGAGEMENTS)[number]

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    createdBy: text('created_by').notNull(),
    title: text('title'),
    /**
     * Blanket visibility (ADR-0032). Lives on this row rather than in a generic
     * table so the hottest read in the product costs no join: resolving access to
     * a conversation needs the row anyway.
     *
     * `private` is the default for new conversations, so sharing is a deliberate
     * act and the access chip means something. How existing conversations were
     * classified is ADR-0032 §"existing conversations".
     */
    visibility: text('visibility').$type<ResourceVisibility>().notNull().default('private'),
    /**
     * When the agent answers a message that tags nobody (ADR-0036).
     *
     *   - `ask`     — a plain message goes to the assistant. Right for the thread
     *                 with one human in it, which is nearly all of them.
     *   - `mention` — a plain message goes to the chat; the assistant answers only
     *                 when tagged. What a real multi-person discussion wants.
     *
     * **NULL means "derive it"**, and derivation is the structural fact: a thread
     * with two or more human authors is in `mention`. Nullable on purpose, so an
     * absent value is never a broken thread and the rule can improve without a
     * backfill. The value is written once, when the flip actually happens, so the
     * derivation query does not run per message forever.
     *
     * Never consulted for a message that DOES tag someone: `@Piloti` always
     * answers and a humans-only tag never starts a turn, in either mode. Those
     * three rules are what make a tag worth typing.
     */
    engagement: text('engagement').$type<ConversationEngagement>(),
    // OIB topic tag keys (fixed vocabulary — see lib/conversations/tags.ts),
    // assigned by the naming LLM and used by the Historie tag filter. Multiple per
    // conversation; empty by default so legacy rows stay valid.
    tags: text('tags').array().notNull().default([]),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * The job that produced this conversation, or NULL when a person started it,
     * which is most conversations.
     *
     * Provenance, not ownership. `created_by` on a job conversation is the JOB'S
     * OWNER, a real user id, because four mechanisms read that column as a
     * person: the sharing roster, the last-owner invariant, `attributeLegacyAuthor`
     * and audit. So this column is the only thing that says "nobody typed this",
     * and two behaviours hang off it:
     *
     *   - the thread renders with the job's name and a job glyph rather than its
     *     owner's face;
     *   - it is kept OUT of the personal sessions list, where a weekly job would
     *     otherwise deposit 52 threads a year on top of its owner's real chats.
     *     It stays fully openable by URL and from the job's run history.
     *
     * `ON DELETE SET NULL`: deleting a job must never delete its output.
     *
     * NOTE: the database has `conversations_job_id_idx`, PARTIAL
     * (`WHERE job_id IS NOT NULL`) so it does not carry an entry for every human
     * chat. Drizzle's index builder cannot express a partial index, so the index
     * is defined in a migration, the same arrangement as `idx_jobs_due`.
     *
     * **It is not unique, and it cannot become unique.** Some rows already share
     * a `job_id`, so a unique index would fail on them, and clearing the
     * duplicates' `job_id` would delete the provenance this column exists for.
     * The invariant is held upstream instead: the thread's id is derived from the
     * definition id, so the PRIMARY KEY plus `ON CONFLICT DO NOTHING` makes
     * „ensure the thread" idempotent.
     */
    jobId: uuid('job_id').references(() => taskDefinitions.id, { onDelete: 'set null' }),
    /**
     * The resource this conversation is ABOUT (file-native ask, ADR-0047).
     * Polymorphic so a later type (a compliance lane) does not need a column.
     * NULL = an ordinary chat, which is almost every row.
     */
    subjectResourceType: text('subject_resource_type').$type<ShareableResourceType>(),
    subjectResourceId: text('subject_resource_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUpdatedIdx: index('conversations_org_updated_idx').on(table.organizationId, table.updatedAt),
    projectIdx: index('conversations_project_idx').on(table.projectId),
    tagsIdx: index('conversations_tags_idx').using('gin', table.tags),
    /**
     * Redundant on its own — `id` is already the primary key — and required all
     * the same: a composite foreign key can only reference a uniquely-constrained
     * column set, and `messages` / `conversation_reads` reference exactly this
     * pair so their denormalised tenant column cannot drift from ours (ADR-0041).
     */
    idOrganizationKey: unique('conversations_id_organization_id_key').on(
      table.id,
      table.organizationId
    ),
  })
)

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
