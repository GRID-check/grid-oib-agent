/**
 * The SQL behind a conversation's restricted use (ADR-0078, ADR-0079, migration
 * 0107): which folders not every member can read it drew on, who it is shared with, and the lock that
 * makes a check of the one against the other a single step.
 *
 * Repository rules: drizzle only, organization in every WHERE, lists bounded.
 * Every function takes the executor it runs on, because the service calls them
 * inside the transaction that holds {@link lockConversationAudience}.
 */

import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import type { DbExecutor } from '@/lib/db/executor'
import {
  conversationRestrictedFolders,
  conversations,
  resourceShares,
  type ResourceVisibility,
} from '@/lib/db/schema'

/**
 * How many source folders one conversation records at most, read back. A
 * project has a handful of restricted folders; the bound is for the query.
 */
export const RECORDED_FOLDERS_LIMIT = 200

/** How many grantees the audience read returns; the sharing roster cap is far below. */
const AUDIENCE_GRANT_LIMIT = 500

/**
 * Serialize every change to who a conversation reaches with every record of
 * what it drew on, until the transaction ends.
 *
 * `admitRestrictedUse` checks the audience and records a collection; a
 * widening (a grant, a wider visibility, an escalation) checks the record and
 * writes the audience. Both take this lock first, so neither can slip between
 * the other's check and write. Keyed by the conversation, which may not exist
 * yet (its first turn runs before the row), so a row lock would not do.
 * Namespaced so it never shares a key with another advisory lock
 * (`storage_quota:`, `document_versions:`).
 */
export async function lockConversationAudience(
  tx: DbExecutor,
  organizationId: string,
  conversationId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`conversation_audience:${organizationId}:${conversationId}`}, 0))`,
  )
}

/** The source folders this conversation recorded, sorted. */
export async function listRecordedSourceFolders(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ folderId: conversationRestrictedFolders.folderId })
    .from(conversationRestrictedFolders)
    .where(
      and(
        eq(conversationRestrictedFolders.organizationId, organizationId),
        eq(conversationRestrictedFolders.conversationId, conversationId),
      ),
    )
    .orderBy(conversationRestrictedFolders.folderId)
    .limit(RECORDED_FOLDERS_LIMIT)
  return rows.map((row) => String(row.folderId))
}

/** Record that the conversation drew on these folders; a repeat bumps `last_at`. */
export async function recordSourceFolders(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
  folderIds: readonly string[],
): Promise<void> {
  if (folderIds.length === 0) return
  await executor
    .insert(conversationRestrictedFolders)
    .values(folderIds.map((folderId) => ({ organizationId, conversationId, folderId })))
    .onConflictDoUpdate({
      target: [
        conversationRestrictedFolders.organizationId,
        conversationRestrictedFolders.conversationId,
        conversationRestrictedFolders.folderId,
      ],
      set: { lastAt: sql`now()` },
    })
}

/** Forget what a conversation drew on: its erasure. */
export async function deleteRecordedSourceFolders(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
): Promise<void> {
  await executor
    .delete(conversationRestrictedFolders)
    .where(
      and(
        eq(conversationRestrictedFolders.organizationId, organizationId),
        eq(conversationRestrictedFolders.conversationId, conversationId),
      ),
    )
}

/** Who can read a conversation: its row (absent before the first message) and its grants. */
export interface ConversationAudienceRow {
  exists: boolean
  projectId: string | null
  createdBy: string | null
  visibility: ResourceVisibility
  grantees: string[]
}

export async function readConversationAudience(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
): Promise<ConversationAudienceRow> {
  const [row] = await executor
    .select({
      projectId: conversations.projectId,
      createdBy: conversations.createdBy,
      visibility: conversations.visibility,
    })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)))
    .limit(1)
  const grants = await executor
    .select({ subjectUserId: resourceShares.subjectUserId })
    .from(resourceShares)
    .where(
      and(
        eq(resourceShares.organizationId, organizationId),
        eq(resourceShares.resourceType, 'conversation'),
        eq(resourceShares.resourceId, conversationId),
      ),
    )
    .limit(AUDIENCE_GRANT_LIMIT)
  return {
    exists: row !== undefined,
    projectId: row?.projectId ?? null,
    createdBy: row?.createdBy ?? null,
    visibility: row?.visibility ?? 'private',
    grantees: [...new Set(grants.map((grant) => String(grant.subjectUserId)))],
  }
}
