/**
 * Where a target an operation names lives: its project, and for a document a
 * chat holds or a conversation, the conversation (`operation-targets.ts`).
 *
 * Repository rules: drizzle only, the organization in every WHERE, one row
 * each. A document, and a model that carries one's facts, is read with the
 * asker's own reader (`findDocumentInOrg`, `findBimModelById`, with
 * `memberReader(userId)`), so a document they may not see does not exist here
 * either, exactly as it does not at its route. Runs in
 * the caller's tenant scope.
 */

import 'server-only'
import { and, eq } from 'drizzle-orm'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { getDb } from '@/lib/db'
import { findBimModelById } from '@/lib/bim/repository'
import { inboundMails, mailThreads, projectFolders, projects, proposedChanges, uploadBatches } from '@/lib/db/schema'
import { hasPassedScreening, memberReader } from '@/lib/documents/document-reader'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { isUuid } from '@/lib/ids'
import type { OperationTarget } from './operation-targets'

export interface TargetPlace {
  /** The project it belongs to; null for the Büroablage, a chat's own file, or a conversation outside any project. */
  projectId: string | null
  /** The conversation it belongs to: a conversation itself, a file dropped into one, a proposal made in one. */
  conversationId: string | null
  /**
   * For a document only: the folder it is filed in (null: its shelf's root), and
   * whether its screening let it through to everyone who may read it, or it is
   * held from all but its uploader and reviewers (ADR-0086). What the workspace
   * door asks before a document's content may land in a shared conversation.
   */
  document?: { folderId: string | null; passedScreening: boolean }
}

const place = (projectId: string | null, conversationId: string | null = null): TargetPlace => ({
  projectId: projectId === null ? null : String(projectId),
  conversationId,
})

/** Where `target` lives in `organizationId`, or null when it does not exist there (for `userId`, for a document). */
export async function findTargetPlace(
  organizationId: string,
  userId: string,
  target: OperationTarget,
): Promise<TargetPlace | null> {
  const db = getDb()
  // A conversation id is free text; every other id is a uuid, and a malformed one names nothing.
  if (target.type === 'conversation') {
    const conversation = await findConversationInOrg(target.id, organizationId)
    return conversation ? place(conversation.projectId, conversation.id) : null
  }
  if (!isUuid(target.id)) return null
  switch (target.type) {
    case 'project': {
      const [row] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, target.id), eq(projects.organizationId, organizationId)))
        .limit(1)
      return row ? place(row.id) : null
    }
    case 'document': {
      const doc = await findDocumentInOrg(target.id, organizationId, memberReader(userId))
      if (!doc) return null
      return {
        ...place(doc.projectId, doc.conversationId ?? null),
        document: { folderId: doc.folderId ?? null, passedScreening: hasPassedScreening(doc) },
      }
    }
    case 'folder': {
      const [row] = await db
        .select({ projectId: projectFolders.projectId })
        .from(projectFolders)
        .where(and(eq(projectFolders.id, target.id), eq(projectFolders.organizationId, organizationId)))
        .limit(1)
      return row ? place(row.projectId) : null
    }
    case 'bim_model': {
      // A model carries its document's facts: read as the asker may see that document (ADR-0086).
      const model = await findBimModelById(target.id, organizationId, memberReader(userId))
      return model ? place(model.projectId) : null
    }
    case 'upload_batch': {
      const [row] = await db
        .select({ projectId: uploadBatches.projectId })
        .from(uploadBatches)
        .where(and(eq(uploadBatches.id, target.id), eq(uploadBatches.organizationId, organizationId)))
        .limit(1)
      return row ? place(row.projectId) : null
    }
    case 'inbound_mail': {
      // Where a held mail is, never what it says: its project only.
      const [row] = await db
        .select({ projectId: inboundMails.projectId })
        .from(inboundMails)
        .where(and(eq(inboundMails.id, target.id), eq(inboundMails.organizationId, organizationId)))
        .limit(1)
      return row ? place(row.projectId) : null
    }
    case 'mail_thread': {
      const [row] = await db
        .select({ projectId: mailThreads.projectId })
        .from(mailThreads)
        .where(and(eq(mailThreads.id, target.id), eq(mailThreads.organizationId, organizationId)))
        .limit(1)
      return row ? place(row.projectId) : null
    }
    case 'proposal': {
      const [row] = await db
        .select({ projectId: proposedChanges.projectId, conversationId: proposedChanges.originConversationId })
        .from(proposedChanges)
        .where(and(eq(proposedChanges.id, target.id), eq(proposedChanges.organizationId, organizationId)))
        .limit(1)
      return row ? place(row.projectId, row.conversationId) : null
    }
  }
}

/** A project's name in `organizationId`, or null. */
export async function findProjectName(organizationId: string, projectId: string): Promise<string | null> {
  if (!isUuid(projectId)) return null
  const [row] = await getDb()
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    .limit(1)
  return row?.name ?? null
}
