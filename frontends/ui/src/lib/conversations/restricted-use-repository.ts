/**
 * The SQL behind a conversation's restricted use (ADR-0087, ADR-0088, migration
 * 0111): which folders not every member can read it drew on, who it is shared with, and the lock that
 * makes a check of the one against the other a single step.
 *
 * Repository rules: drizzle only, organization in every WHERE, lists bounded.
 * Every function takes the executor it runs on, because the service calls them
 * inside the transaction that holds {@link lockConversationAudience}.
 */

import 'server-only'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { DbExecutor } from '@/lib/db/executor'
import {
  conversationRestrictedFolders,
  conversations,
  documents,
  resourceShares,
  taskRuns,
  type ResourceVisibility,
} from '@/lib/db/schema'

/**
 * How many source folders one conversation records at most, read back. A
 * project has a handful of restricted folders; the bound is for the query.
 */
export const RECORDED_FOLDERS_LIMIT = 200

/** Rows read back for a whole list of conversations: a list is at most `CONVERSATION_LIST_LIMIT`, each with a handful of folders. */
const RECORDED_FOLDERS_BATCH_LIMIT = 5_000

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

/**
 * The subject id of a revision run, as a uuid when it is one, else null (a plan
 * is jsonb). Built when asked rather than at import: narrow schema doubles in
 * unit specs that import this module carry no `taskRuns`.
 */
function subjectDocumentId() {
  return sql`case
  when ${taskRuns.plan}->'subject'->>'documentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then (${taskRuns.plan}->'subject'->>'documentId')::uuid
end`
}

/**
 * The current folder of every document a revision task written into these
 * conversations revises (ADR-0091). Read alongside the record: the thread holds
 * the draft's text and the revised draft, so it is read as a conversation that
 * drew on the folder the document is in NOW. Not stored: a document moved, or
 * a folder loosened, changes the answer at the next read. A document that is
 * gone, or that sits at a project's root, adds nothing.
 */
async function listRevisionSubjectFolders(
  executor: DbExecutor,
  organizationId: string,
  conversationIds: readonly string[],
): Promise<{ conversationId: string; folderId: string }[]> {
  if (conversationIds.length === 0) return []
  const rows = await executor
    .select({ conversationId: taskRuns.conversationId, folderId: documents.folderId })
    .from(taskRuns)
    .innerJoin(
      documents,
      and(eq(documents.organizationId, taskRuns.organizationId), sql`${documents.id} = ${subjectDocumentId()}`),
    )
    .where(
      and(
        eq(taskRuns.organizationId, organizationId),
        eq(taskRuns.kind, 'revision'),
        inArray(taskRuns.conversationId, [...conversationIds]),
        isNotNull(documents.folderId),
      ),
    )
    .limit(RECORDED_FOLDERS_BATCH_LIMIT)
  return rows.flatMap((row) =>
    row.conversationId && row.folderId ? [{ conversationId: String(row.conversationId), folderId: String(row.folderId) }] : [],
  )
}

/**
 * The source folders this conversation recorded, sorted, with the current
 * folders of the documents its revision tasks revise.
 */
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
  const subjects = await listRevisionSubjectFolders(executor, organizationId, [conversationId])
  return [...new Set([...rows.map((row) => String(row.folderId)), ...subjects.map((row) => row.folderId)])]
    .sort()
    .slice(0, RECORDED_FOLDERS_LIMIT)
}

/**
 * The source folders each of these conversations recorded, and the current
 * folders of the documents their revision tasks revise, for the conversations
 * with any: how a list asks "which of these did restricted content enter" in
 * one read per table. Absent from the map means none.
 */
export async function listRecordedSourceFoldersFor(
  executor: DbExecutor,
  organizationId: string,
  conversationIds: readonly string[],
): Promise<Map<string, string[]>> {
  const recorded = new Map<string, string[]>()
  if (conversationIds.length === 0) return recorded
  const rows = await executor
    .select({
      conversationId: conversationRestrictedFolders.conversationId,
      folderId: conversationRestrictedFolders.folderId,
    })
    .from(conversationRestrictedFolders)
    .where(
      and(
        eq(conversationRestrictedFolders.organizationId, organizationId),
        inArray(conversationRestrictedFolders.conversationId, [...conversationIds]),
      ),
    )
    .limit(RECORDED_FOLDERS_BATCH_LIMIT)
  const subjects = await listRevisionSubjectFolders(executor, organizationId, conversationIds)
  for (const row of [...rows, ...subjects]) {
    const folders = recorded.get(String(row.conversationId)) ?? []
    if (!folders.includes(String(row.folderId))) folders.push(String(row.folderId))
    recorded.set(String(row.conversationId), folders)
  }
  return recorded
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

/**
 * Mark one answer of this conversation as drawing on a folder with restricted
 * access, when the database's rule says the conversation does
 * (`grid_conversation_restricted_use`, migration 0123, ADR-0091). Keyed by the
 * answer's message id, which the agent mints for the turn and the vote names,
 * so the mark exists whether or not the answer is ever persisted. Idempotent;
 * the runtime role may insert marks and never lift one.
 */
export async function markAnswerRestrictedUse(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO message_restricted_use (organization_id, message_id, conversation_id)
    SELECT ${organizationId}, ${messageId}, ${conversationId}
    WHERE grid_conversation_restricted_use(${organizationId}, ${conversationId})
    ON CONFLICT DO NOTHING`)
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
