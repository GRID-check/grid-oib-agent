import { check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * `conversation_restricted_folders` — a folder not every project member can
 * read, whose content this conversation drew on (ADR-0087, migration 0111):
 * content from it entered the model's context in some turn (a retrieval hit,
 * an opened document). Listing is not use.
 *
 * The record names the SOURCE FOLDER, never a collection or a role list, and
 * who may read the conversation is decided at READ time against the folder's
 * current access (`lib/conversations/restricted-use.ts`): loosening the folder
 * opens the conversation, tightening it closes it, with nothing rewritten.
 *
 * Written only by `admitRestrictedUse`, under the per-conversation lock every
 * widening of the conversation's audience takes too.
 *
 * No foreign key, on purpose: not to `conversations`, because the first turn of
 * a new chat runs before its row exists (`deleteConversationInOrg` removes the
 * rows with the conversation); and not to `project_folders`, because a deleted
 * folder must not take the record with it. A folder id that no longer exists
 * is read as a folder nobody may read.
 */
export const conversationRestrictedFolders = pgTable(
  'conversation_restricted_folders',
  {
    organizationId: text('organization_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    folderId: uuid('folder_id').notNull(),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'conversation_restricted_folders_pk',
      columns: [table.organizationId, table.conversationId, table.folderId],
    }),
    order: check('conversation_restricted_folders_order', sql`${table.lastAt} >= ${table.firstAt}`),
  })
)

export type ConversationRestrictedFolder = typeof conversationRestrictedFolders.$inferSelect
