/**
 * Session-documents service — business logic for a file attached privately to
 * one chat (ADR-0047 Phase 2, `scope = 'session'`).
 *
 * The third shelf, and the last one to become real rows. Until now a session
 * upload went from the browser straight to the Python ingestor
 * (`POST /api/v1/collections/s_<id>/documents`), which is why it had no storage
 * ledger entry, no audit trail, no delete that reached SeaweedFS, and — since
 * ADR-0045 — no way to reach the model pipeline at all, so an IFC dropped into
 * a chat was embedded as raw STEP text instead of being parsed into a building.
 *
 * Like the Archiv (`lib/archiv/*`), this REUSES the document pipeline wholesale
 * — the SeaweedFS upload, the quota admission, the model-vs-ingest dispatcher
 * (`dispatchDocument`), the upload allow-list, status reconciliation, and the
 * scope-aware item routes. Only the authorization differs, and here it differs
 * more than the Archiv's does: an Archiv document is org-wide, a session
 * document is as private as the conversation it hangs off, so access is
 * resolved through `requireResourceAccess(session, 'conversation', …)` — the
 * same ladder that governs the messages sitting next to the file (ADR-0032).
 *
 * Route handlers stay thin; failures are signalled with typed errors from
 * `@/lib/api/errors`.
 */

import 'server-only'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { s3Client, bucketAdminS3Client, buildSessionStorageKey } from '@/lib/s3'
import { ensureTenantBucketChecked } from '@/lib/storage/bucket'
import { recordAuditEvent } from '@/lib/audit/service'
import { NotFoundError, UpstreamError } from '@/lib/api/errors'
import { sessionCollectionName } from '@/lib/collection-scope'
import { requireResourceAccess } from '@/lib/sharing/access'
import { assertConversationAcceptsUploads, createConversation } from '@/lib/conversations/service'
import {
  assertFileSizeAllowed,
  assertUploadTypeAllowed,
  dispatchDocument,
} from '@/lib/documents/service'
import { assertWithinStorageQuota } from '@/lib/storage/service'
import { admitOrDiscard, admitReplacementOrDiscard } from '@/lib/storage/admission'
import { contentDigest } from '@/lib/documents/content-digest'
import { reconcileDocumentStatuses, type DocumentMetadata } from '@/lib/documents/reconcile-status'
import { findLiveDocumentByFilename, type DocumentListRow } from '@/lib/documents/repository'
import { deleteDocumentObjects, discardSupersededObjects } from '@/lib/documents/object-cleanup'
import type { AuthorizedSession } from '@/lib/auth/types'
import { purgeCollectionChunks } from './cleanup'
import { collectionFileRef } from '@/lib/documents/collection-file-ref'
import {
  deleteSessionDocument as deleteSessionDocumentRow,
  findSessionDocument,
  listSessionDocuments as listSessionDocumentRows,
} from './repository'

export interface SessionDocumentListResult {
  documents: Array<Omit<DocumentListRow, 'metadata'> & DocumentMetadata>
  collectionName: string
}

/**
 * List one conversation's private attachments, lazily reconciling in-flight
 * ingestion statuses with the backend — the same treatment `listDocuments`
 * gives a project's corpus.
 *
 * `viewer` on the conversation, which is the same access the messages beside
 * the file need. The internal `metadata` jsonb never leaves the BFF.
 */
export async function listSessionDocuments(
  session: AuthorizedSession,
  conversationId: string,
): Promise<SessionDocumentListResult> {
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')

  const rows = await listSessionDocumentRows(conversationId, session.organizationId)
  const reconciled = await reconcileDocumentStatuses(rows, session.organizationId)

  return {
    documents: reconciled.map(({ metadata: _metadata, ...row }) => row),
    collectionName: sessionCollectionName(conversationId),
  }
}

export interface UploadSessionDocumentInput {
  conversationId: string
  /**
   * The project the chat belongs to, used ONLY when the conversation row has to
   * be created here. It is not written onto the document: a session document
   * has a NULL `projectId`, following the Archiv precedent, because its shelf is
   * the conversation and nothing else.
   */
  projectId?: string | null
  file: File
}

export interface UploadSessionDocumentResult {
  documentId: string
  jobId: string | null
  /** `processing` is the IFC path — see `UploadDocumentResult`. */
  status: 'pending' | 'uploaded' | 'failed' | 'processing'
  filename: string
  collectionName: string
}

/**
 * Store a file attached to a chat, record it as a `session`-scoped document,
 * and hand it to the pipeline.
 *
 * ## Why this creates the conversation
 *
 * A chat id is minted in the browser and the row appears when the first message
 * is persisted, so a file dropped into a brand-new thread would have no
 * conversation to point at. `createConversation` is already create-if-missing
 * (the client fires it per appended message) and it is the function that
 * authorizes: it demands `project:view` when a project is named, and for an id
 * that already exists it resolves `collaborator` on the conversation before
 * handing the row back. So calling it here is both the fix for the ordering and
 * the authorization for the upload — and it is honest about what happened:
 * attaching a file to a conversation is as much a reason for the thread to
 * exist as typing in it.
 *
 * Ingest is best-effort (the file is already durable in SeaweedFS + Postgres);
 * status reads reconcile the outcome.
 */
export async function uploadSessionDocument(
  session: AuthorizedSession,
  input: UploadSessionDocumentInput,
  request: Request,
): Promise<UploadSessionDocumentResult> {
  const { conversationId, file } = input

  // Authorization + the row the document's foreign key needs, in one call.
  await createConversation(session, { id: conversationId, projectId: input.projectId ?? null })

  await assertUploadTypeAllowed(session, file.name)
  assertFileSizeAllowed(file.size, file.name)
  // The same org ceiling as every other shelf: a chat attachment is bytes in
  // the tenant's bucket, so it must not be the way around the quota (ADR-0042).
  await assertWithinStorageQuota(session.organizationId, file.size)

  const collectionName = sessionCollectionName(conversationId)
  // Same replace-on-re-upload rule as the project and Archiv paths, through the
  // same helpers — see `uploadDocument`. A chat attachment is the same table
  // with `scope = 'session'`, and the ingest pipeline replaces chunks by
  // filename regardless of shelf, so dropping a corrected file into a chat a
  // second time left the same paid-for ghost here: the first row listed and
  // downloadable, its passages already replaced by the second's.
  const superseded = await findLiveDocumentByFilename(session.organizationId, collectionName, file.name)
  const documentId = superseded?.id ?? crypto.randomUUID()
  const storageKey = buildSessionStorageKey(session.organizationId, conversationId, documentId, file.name)

  // Same provisioning step as the other shelves (ADR-0043): a session
  // attachment shares the tenant's bucket, because it shares the tenant's bytes.
  const storageBucket = await ensureTenantBucketChecked(bucketAdminS3Client, session.organizationId)

  const bytes = Buffer.from(await file.arrayBuffer())
  // The same digest the other two shelves record, from the same helper — see
  // `@/lib/documents/content-digest` for why it is not written out here.
  const contentHash = contentDigest(bytes)

  // The LAST thing before a single byte is written, and the reason it is here
  // rather than folded into the authorization above.
  //
  // Discarding a chat erases its attachments' objects and chunks first and
  // deletes the conversation row second (`conversations/service`), and the
  // document rows cascade off that row. An upload that got past
  // `createConversation` while the discard was still purging would land its
  // object and its chunks AFTER the sweep had walked past them, and then have
  // its row taken by the cascade — bytes and chunks in the tenant's stores with
  // nothing naming them, which is precisely the state no retry can reach.
  //
  // The discard marks the conversation as deleting BEFORE it starts purging, so
  // re-reading that mark at the last possible moment narrows the race to the
  // gap between this check and the write. `admitOrDiscard` below is the second
  // guard: its insert names the conversation through a foreign key, so a row
  // whose conversation went in that gap cannot be created at all.
  await assertConversationAcceptsUploads(conversationId, session.organizationId)

  await s3Client.send(
    new PutObjectCommand({
      Bucket: storageBucket,
      Key: storageKey,
      Body: bytes,
      ContentType: file.type || 'application/octet-stream',
    }),
  )

  // Same hard ceiling and the same compensating delete on refusal as the
  // project and Archiv paths (ADR-0042).
  if (superseded) {
    // The row is already counted against the quota, so the charge is the delta.
    await admitReplacementOrDiscard(storageBucket, storageKey, session.organizationId, documentId, {
      storageKey,
      storageBucket,
      fileSize: file.size,
      contentType: file.type || null,
      contentHash,
      folderId: null,
      createdBy: session.userId,
    })
    // The key is a pure function of the id here, so the new bytes land on the
    // old ones; what is stale is the thumbnail and the parsed building beside
    // them. Best-effort: the row is already correct.
    await discardSupersededObjects(superseded, storageKey, 'session-documents')
  } else {
    await admitOrDiscard(storageBucket, storageKey, {
      id: documentId,
      organizationId: session.organizationId,
      // NULL, following the Archiv precedent: the shelf IS the conversation, and
      // a project id here would put the row inside a project's estate while it
      // is readable only by the people in one chat.
      projectId: null,
      scope: 'session',
      conversationId,
      folderId: null,
      createdBy: session.userId,
      filename: file.name,
      storageKey,
      storageBucket,
      collectionName,
      fileSize: file.size,
      contentType: file.type || null,
      contentHash,
      status: 'uploaded',
    })
  }

  // The whole point of Phase 2: a session upload now reaches the SAME dispatcher
  // the other shelves use, so an IFC dropped into a chat is parsed into a
  // building instead of being embedded as STEP noise.
  const { jobId, status } = await dispatchDocument({
    organizationId: session.organizationId,
    projectId: null,
    documentId,
    filename: file.name,
    storageKey,
    storageBucket,
    collectionName,
  })

  // Data-provenance event: who brought which file into which conversation.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'session.document.uploaded',
    targetType: 'document',
    targetId: documentId,
    metadata: {
      conversationId,
      filename: file.name.slice(0, 200),
      fileSize: file.size,
      ...(superseded ? { replaced: true } : {}),
    },
    request,
  })

  return { documentId, jobId, status, filename: file.name, collectionName }
}

/**
 * Delete one session document: purge its RAG chunks, remove the SeaweedFS
 * objects, delete the row, and audit — **in that order, and only that far**.
 *
 * `collaborator` on the owning conversation — the same access appending a
 * message needs, and the same access the upload needed. A row whose scope is
 * not `session` is not visible from here at all (the repository's predicate),
 * so a project or Archiv id surfaces as a 404 rather than being force-fit
 * through conversation access.
 *
 * A failure to erase either store keeps the row and answers 502. The row is
 * what names the object and the chunks, so deleting it on a failed purge is how
 * a transient backend blip becomes a private file nobody can ever remove; the
 * user is told the delete did not happen, which is the truth, and a retry
 * reaches exactly the same document.
 */
export async function deleteSessionDocument(
  session: AuthorizedSession,
  documentId: string,
  request: Request,
): Promise<void> {
  const doc = await findSessionDocument(documentId, session.organizationId)
  // `conversationId` is non-NULL for every `scope = 'session'` row — the
  // database says so (`documents_session_requires_conversation`, migration
  // 0046). The check is here because the type is nullable for the other
  // shelves, and answering 404 is the right response to a row that somehow
  // contradicts the constraint.
  if (!doc?.conversationId) throw new NotFoundError()

  await requireResourceAccess(session, 'conversation', doc.conversationId, 'collaborator')

  // `collectionFileRef` or nothing: a row that owns no chunks has none to purge,
  // and purging by its filename would address whatever human document shares it.
  const purgeRef = collectionFileRef(doc)
  const chunks = await purgeCollectionChunks(doc.collectionName, purgeRef ? [purgeRef] : [])
  const objects = await deleteDocumentObjects(doc)
  if (!chunks.ok || !objects.ok) {
    // Reasons carry bucket names and upstream error text, so they go to the log
    // and NOT into the error payload the client sees.
    console.error(
      '[session-documents] delete aborted, row retained for retry:',
      documentId,
      [chunks.reason, objects.reason].filter(Boolean).join('; '),
    )
    throw new UpstreamError('Deleting the attachment failed; nothing was removed. Please try again.')
  }

  await deleteSessionDocumentRow(documentId, session.organizationId, doc.conversationId)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'session.document.deleted',
    targetType: 'document',
    targetId: documentId,
    metadata: {
      conversationId: doc.conversationId,
      filename: doc.filename.slice(0, 200),
      collectionName: doc.collectionName,
    },
    request,
  })
}
