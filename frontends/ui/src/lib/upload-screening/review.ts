/**
 * Clearing the quarantine (ADR-0085): who may, what release does, and the
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
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { filedInOf } from '@/lib/audit/document-names'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canManageArchiv } from '@/lib/authz/organizations'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { isFolderVisibleTo, requireFolderWrite } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Document } from '@/lib/db/schema'
import {
  findDocumentInOrg,
  listQuarantinedDocuments,
  markScreeningReleased,
  QUARANTINE_LIST_LIMIT,
  type QuarantineCursor,
} from '@/lib/documents/repository'
import { dispatchDocument } from '@/lib/documents/service'
import { resolveDocumentFolderPath } from '@/lib/documents/folder-path'
import { parseQuarantine, type QuarantineVerdict } from './quarantine'

type ReviewedDocument = Pick<Document, 'scope' | 'projectId' | 'folderId'>

/** Whether this session may release or delete this quarantined document. Never throws. */
export async function mayReviewQuarantine(session: AuthorizedSession, doc: ReviewedDocument): Promise<boolean> {
  if (hasPermission(session, ORG_PERMISSIONS.projectsAdminister)) return true
  if (doc.scope === 'archiv') return canManageArchiv(session)
  if (doc.scope !== 'project' || !doc.projectId) return false
  try {
    await requireProjectAccess(session, doc.projectId, 'project:manage')
  } catch {
    return false
  }
  // A project admin who is not cleared for the document's folder does not
  // review it: they could not see it anywhere else either (ADR-0086).
  return isFolderVisibleTo(session, doc.projectId, doc.folderId).catch(() => false)
}

export interface ReleaseResult {
  id: string
  status: 'pending' | 'uploaded' | 'failed' | 'processing'
  jobId: string | null
}

/**
 * Release a quarantined document for indexing.
 *
 * Refuses (409) anything not quarantined, and a document without a content
 * digest: a release names the bytes it releases, so a row with no digest could
 * only be released for whatever bytes it holds next. Every upload since
 * migration 0078 records one.
 */
export async function releaseQuarantinedDocument(
  session: AuthorizedSession,
  documentId: string,
  request: Request
): Promise<ReleaseResult> {
  const doc = await findDocumentInOrg(documentId, session.organizationId)
  // Not found and not allowed answer alike: a reviewer of one project learns
  // nothing about another project's quarantine.
  if (!doc || !(await mayReviewQuarantine(session, doc))) throw new NotFoundError('Document not found')
  if (doc.status !== 'quarantined') {
    throw new ConflictError('Only a quarantined document can be released', { status: doc.status })
  }
  if (!doc.contentHash || !doc.storageKey) {
    throw new ConflictError('This document has no recorded digest, so its release cannot name its bytes')
  }
  // Releasing files the document into its folder for good: a write there
  // (ADR-0087). A reviewer who may only read the folder sees the document and
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

  const reasons = parseQuarantine(doc.errorMessage)?.reasons ?? []
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
      // Kinds only: a detector's masked sample stays on the row.
      reasons: [...new Set(reasons.map((reason) => reason.kind))].join(',').slice(0, 200),
      // The office's words found in the text say what the document holds, so
      // they go under `terms`, which is withheld with the name when the folder
      // is restricted (DOCUMENT_NAME_KEYS, ADR-0086).
      terms: [...new Set(reasons.flatMap((reason) => (reason.kind === 'term' && reason.term ? [reason.term] : [])))]
        .join(',')
        .slice(0, 200),
    },
    request,
  })
  return { id: doc.id, status, jobId }
}

export interface QuarantineQueueItem {
  id: string
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
    filename: row.filename,
    scope: row.scope,
    projectId: row.projectId,
    conversationId: row.conversationId,
    uploadedBy: row.createdBy,
    quarantinedAt: new Date(row.updatedAt).toISOString(),
    verdict: parseQuarantine(row.errorMessage),
  }))
}
