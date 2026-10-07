/**
 * The SQL behind a conversation's restricted use (ADR-0080, ADR-0081, migration
 * 0109): which folders not every member can read it drew on, who it is shared with, and the lock that
 * makes a check of the one against the other a single step.
 *
 * Repository rules: drizzle only, organization in every WHERE, lists bounded.
 * Every function takes the executor it runs on, because the service calls them
 * inside the transaction that holds {@link lockConversationAudience}.
 */

import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DbExecutor } from '@/lib/db/executor'
import {
  conversationRestrictedFolders,
  conversationSourceProjects,
  conversations,
  projectFolders,
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

/** Rows read back for a whole list of conversations: a list is at most `CONVERSATION_LIST_LIMIT`, each with a handful of folders. */
const RECORDED_FOLDERS_BATCH_LIMIT = 5_000

/**
 * The source folders each of these conversations recorded, for the
 * conversations that recorded any: how a list asks "which of these did
 * restricted content enter" in one read. Absent from the map means none.
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
  for (const row of rows) {
    const folders = recorded.get(String(row.conversationId)) ?? []
    folders.push(String(row.folderId))
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

/**
 * How many other projects one conversation records at most, read back. The
 * lookups search at most a page of projects per call; the bound is for the query.
 */
export const RECORDED_PROJECTS_LIMIT = 200

/** The other projects this conversation drew on (ADR-0082, migration 0120), sorted. */
export async function listRecordedSourceProjects(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ projectId: conversationSourceProjects.projectId })
    .from(conversationSourceProjects)
    .where(
      and(
        eq(conversationSourceProjects.organizationId, organizationId),
        eq(conversationSourceProjects.conversationId, conversationId),
      ),
    )
    .orderBy(conversationSourceProjects.projectId)
    .limit(RECORDED_PROJECTS_LIMIT)
  return rows.map((row) => String(row.projectId))
}

/** The other projects each of these conversations drew on; absent from the map means none. */
export async function listRecordedSourceProjectsFor(
  executor: DbExecutor,
  organizationId: string,
  conversationIds: readonly string[],
): Promise<Map<string, string[]>> {
  const recorded = new Map<string, string[]>()
  if (conversationIds.length === 0) return recorded
  const rows = await executor
    .select({
      conversationId: conversationSourceProjects.conversationId,
      projectId: conversationSourceProjects.projectId,
    })
    .from(conversationSourceProjects)
    .where(
      and(
        eq(conversationSourceProjects.organizationId, organizationId),
        inArray(conversationSourceProjects.conversationId, [...conversationIds]),
      ),
    )
    .limit(RECORDED_FOLDERS_BATCH_LIMIT)
  for (const row of rows) {
    const projects = recorded.get(String(row.conversationId)) ?? []
    projects.push(String(row.projectId))
    recorded.set(String(row.conversationId), projects)
  }
  return recorded
}

/** Record that the conversation drew on these other projects; a repeat bumps `last_at`. */
export async function recordSourceProjects(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
  projectIds: readonly string[],
): Promise<void> {
  if (projectIds.length === 0) return
  await executor
    .insert(conversationSourceProjects)
    .values(projectIds.map((projectId) => ({ organizationId, conversationId, projectId })))
    .onConflictDoUpdate({
      target: [
        conversationSourceProjects.organizationId,
        conversationSourceProjects.conversationId,
        conversationSourceProjects.projectId,
      ],
      set: { lastAt: sql`now()` },
    })
}

/**
 * The project each of these folders belongs to, for the folders of this
 * organization that belong to one (an Archiv folder has none). How a record
 * that names a folder of ANOTHER project (ADR-0082) finds the tree that judges
 * it; a folder id not found stays unknown, which is a folder nobody may read.
 */
export async function projectsOfFolders(
  executor: DbExecutor,
  organizationId: string,
  folderIds: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (folderIds.length === 0) return found
  const rows = await executor
    .select({ id: projectFolders.id, projectId: projectFolders.projectId })
    .from(projectFolders)
    .where(and(eq(projectFolders.organizationId, organizationId), inArray(projectFolders.id, [...folderIds])))
    .limit(RECORDED_FOLDERS_BATCH_LIMIT)
  for (const row of rows) if (row.projectId) found.set(String(row.id), String(row.projectId))
  return found
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
