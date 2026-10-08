/**
 * Clearing the quarantine (ADR-0083): who may, what release does, and the
 * reviewers' queue.
 *
 * A quarantined document's bytes are in the tenant's bucket and nothing of it
 * is indexed. A reviewer either releases it — it is dispatched again with
 * screening skipped for exactly these bytes — or deletes it through the
 * shelf's ordinary delete. Reviewers are the organization's admins
 * (`org:projects:administer`) and, for a project document, that project's
 * admins (`project:manage`); for the Büroablage, whoever curates it
 * (`org:archiv:manage`). A chat attachment has no project admin, so only the
 * organization's admins review it.
 */

import 'server-only'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { filedInOf } from '@/lib/audit/document-names'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import type { Document } from '@/lib/db/schema'
import {
  findDocumentInOrg,
  listQuarantinedDocuments,
  markScreeningReleased,
  QUARANTINE_LIST_LIMIT,
  type QuarantineCursor,
} from '@/lib/documents/repository'
import { internalRead, isHeldAtRest } from '@/lib/documents/document-reader'
import { getAccessibleDocument } from '@/lib/documents/access'
import { dispatchDocument, type DispatchDocumentResult } from '@/lib/documents/service'
import { resolveDocumentFolderPath } from '@/lib/documents/folder-path'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems } from '@/lib/inbox/service'
import { quarantineReviewersOf } from '@/lib/upload-batches/settle'
import { auditedQuarantineReasons, parseQuarantine, type QuarantineVerdict } from './quarantine'
import { mayReviewQuarantine } from './quarantine-reviewers'

export { mayReviewQuarantine }

export interface ReleaseResult {
  id: string
  status: DispatchDocumentResult['status']
  jobId: string | null
}

/**
 * Release a held document for indexing.
 *
 * Takes a quarantine, and a file the gate never reached a verdict on and that
 * is no longer in flight (`isHeldAtRest`): an IFC model too large to read, a
 * file whose reading failed, a row stranded before its dispatch. Without this
 * such a file stayed with its uploader for good, since a retry fails the same
 * way. Refuses (409) anything else, and a document without a content digest:
 * a release names the bytes it releases, so a row with no digest could only be
 * released for whatever bytes it holds next. Every upload since migration 0078
 * records one.
 */
export async function releaseQuarantinedDocument(
  session: AuthorizedSession,
  documentId: string,
  request: Request
): Promise<ReleaseResult> {
  const doc = await findDocumentInOrg(documentId, session.organizationId, internalRead('quarantine-review'))
  // Not found and not allowed answer alike: a reviewer of one project learns
  // nothing about another project's quarantine.
  if (!doc || !(await mayReviewQuarantine(session, doc))) throw new NotFoundError('Document not found')
  if (!isHeldAtRest(doc)) {
    throw new ConflictError('Only a held document can be released', { status: doc.status })
  }
  if (!doc.contentHash || !doc.storageKey) {
    throw new ConflictError('This document has no recorded digest, so its release cannot name its bytes')
  }
  // Releasing files the document into its folder for good: a write there
  // (ADR-0085). A reviewer who may only read the folder sees the document and
  // cannot release it (403); an organization admin writes everywhere.
  if (doc.scope === 'project' && doc.projectId) await requireFolderWrite(session, doc.projectId, [doc.folderId])

  const releasedAt = new Date()
  const took = await markScreeningReleased(doc.id, session.organizationId, {
    contentHash: doc.contentHash,
    releasedBy: session.userId,
    releasedAt,
  })
  if (!took) throw new ConflictError('The document changed while it was being released; open it again')

  const { jobId, status } = await dispatchDocument({
    organizationId: session.organizationId,
    projectId: doc.projectId,
    documentId: doc.id,
    filename: doc.filename,
    storageKey: doc.storageKey,
    storageBucket: doc.storageBucket,
    collectionName: doc.collectionName,
    folderPath: await resolveDocumentFolderPath(doc, session.organizationId),
  })

  const verdict = parseQuarantine(doc.errorMessage)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.quarantine_released',
    targetType: 'document',
    targetId: doc.id,
    filedIn: filedInOf(doc),
    metadata: {
      projectId: doc.projectId ?? '',
      filename: doc.filename.slice(0, 200),
      // Kinds and terms only: a detector's masked sample stays on the row.
      reasons: auditedQuarantineReasons(verdict),
    },
    request,
  })
  return { id: doc.id, status, jobId }
}

export interface ReleaseRequestResult {
  id: string
  /** How many reviewers were told. Zero when the uploader is the only one who could release it. */
  notified: number
}

/**
 * The uploader asks for their quarantined file to be released („Freigabe
 * anfragen", ADR-0083). It releases nothing: it tells the people who may
 * release it, through the inbox, that somebody is waiting on their decision.
 *
 * Only the uploader asks. Everyone else is told the document does not exist,
 * exactly as `getAccessibleDocument` tells them on every other path; a reviewer
 * who is not the uploader is refused (403), since they can release it
 * themselves. Asking again about the same file folds into the reviewer's
 * existing row.
 */
export async function requestQuarantineRelease(
  session: AuthorizedSession,
  documentId: string
): Promise<ReleaseRequestResult> {
  const doc = await getAccessibleDocument(session, documentId)
  if (doc.createdBy !== session.userId) throw new ForbiddenError('Only the uploader asks for a release')
  if (!isHeldAtRest(doc)) {
    throw new ConflictError('Only a held document can be asked for', { status: doc.status })
  }

  const reviewers = (await quarantineReviewersOf(session.organizationId, doc)).filter(
    (userId) => userId !== session.userId
  )
  await emitInboxItems(
    reviewers.map((reviewer) => ({
      organizationId: session.organizationId,
      recipientUserId: reviewer,
      type: 'document.release_requested' as const,
      resourceType: 'organization' as const,
      resourceId: session.organizationId,
      anchorId: doc.id,
      actorUserId: session.userId,
      groupKey: inboxGroupKey('document.release_requested', 'organization', session.organizationId, doc.id),
      // The file's name, which every recipient may already see in their queue.
      payload: { subject: doc.filename },
    }))
  )
  return { id: doc.id, notified: reviewers.length }
}

export interface QuarantineQueueItem {
  id: string
  /**
   * Why it is held: the gate quarantined it, or its reading ended without a
   * verdict (`unscreened`), which the queue says instead of a reason.
   */
  held: 'quarantined' | 'unscreened'
  filename: string
  scope: Document['scope']
  projectId: string | null
  conversationId: string | null
  uploadedBy: string
  quarantinedAt: string
  verdict: QuarantineVerdict | null
}

/**
 * The quarantined documents this session may review, newest first. An org
 * admin sees the organization's whole queue; a project admin sees their
 * projects' part of it. A session that may review nothing gets an empty list,
 * not a 403: "nothing waits for you" is the true answer.
 */
/** Pages of the organization's quarantine one queue read may look through. */
export const QUARANTINE_QUEUE_PAGES = 10

export async function listQuarantineQueue(session: AuthorizedSession): Promise<QuarantineQueueItem[]> {
  const verdictByPlace = new Map<string, Promise<boolean>>()
  const mayReview = (row: Document): Promise<boolean> => {
    // One check per project and folder, not per document.
    const key = `${row.scope}:${row.projectId ?? ''}:${row.folderId ?? ''}`
    let allowed = verdictByPlace.get(key)
    if (!allowed) {
      allowed = mayReviewQuarantine(session, row)
      verdictByPlace.set(key, allowed)
    }
    return allowed
  }

  // Authorized page by page, and read on until the reviewer's own list is full:
  // limiting before authorizing let another project's newer quarantine push
  // this reviewer's documents out of their queue.
  const visible: Document[] = []
  let cursor: QuarantineCursor | null = null
  for (let page = 0; page < QUARANTINE_QUEUE_PAGES && visible.length < QUARANTINE_LIST_LIMIT; page += 1) {
    const rows = await listQuarantinedDocuments(session.organizationId, cursor)
    const verdicts = await Promise.all(rows.map(mayReview))
    visible.push(...rows.filter((_, index) => verdicts[index]))
    if (rows.length < QUARANTINE_LIST_LIMIT) break
    const last = rows[rows.length - 1]
    cursor = { updatedAt: new Date(last.updatedAt), id: last.id }
  }

  return visible.slice(0, QUARANTINE_LIST_LIMIT).map((row) => ({
    id: row.id,
    held: row.status === 'quarantined' ? ('quarantined' as const) : ('unscreened' as const),
    filename: row.filename,
    scope: row.scope,
    projectId: row.projectId,
    conversationId: row.conversationId,
    uploadedBy: row.createdBy,
    quarantinedAt: new Date(row.updatedAt).toISOString(),
    verdict: parseQuarantine(row.errorMessage),
  }))
}
