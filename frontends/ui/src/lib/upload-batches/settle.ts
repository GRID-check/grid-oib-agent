/**
 * What happens when documents come to rest (ADR-0086): their upload completes
 * and its uploader is told, and a quarantined file's quarantine is audited and
 * its reviewers are told.
 *
 * `onDocumentsSettled` is called by status reconciliation for every row it
 * moved to a terminal status, on a reader's read or the sweep's, and by a
 * retry that finds the job already finished. It never throws into its caller:
 * a read that reconciled a status must not fail because a notification could
 * not be sent. What it leaves undone is mostly not lost:
 *
 *  - A batch that did not complete stays open (`completed_at` NULL), and the
 *    seal and the sweep complete it later (`settleUploadBatches`).
 *  - A batch that completed but whose uploader's inbox item could not be
 *    written is reopened, so the sweep completes it and tells them again. Lost
 *    only if the database refuses the reopen too.
 *  - An unsent quarantine stays owed in `document_quarantine_decisions` until
 *    the sweep sends it.
 *
 * The reviewers' inbox item is the exception: it is sent by the read that
 * moved the row, once, and a write of it that fails is not retried.
 *
 * Imports nothing from reconciliation, which imports this.
 */

import 'server-only'
import type { Document, UploadBatch } from '@/lib/db/schema'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { internalRead } from '@/lib/documents/document-reader'
import { isQuarantineReviewer } from '@/lib/documents/quarantine-reviewers'
import { announceSettledVersions } from '@/lib/documents/revision-notify'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, type InboxEmission } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { queueIntakeReadsAfterUpload } from '@/lib/project-intake/trigger'
import { queueFilingReviewsAfterSettle } from '@/lib/filing/trigger'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { quarantineNoticePayload } from '@/lib/upload-screening/quarantine'
import { auditOwedQuarantines } from '@/lib/upload-screening/quarantine-audit'
import { batchIdsOfDocuments, completeSettledBatches, reopenCompletedBatches } from './repository'

export interface SettledDocument {
  id: string
  status: string
}

/** Settle after reconciliation moved these rows. Never throws. */
export async function onDocumentsSettled(organizationId: string, settled: readonly SettledDocument[]): Promise<void> {
  if (settled.length === 0) return
  try {
    const quarantined = settled.filter((row) => row.status === 'quarantined').map((row) => row.id)
    if (quarantined.length > 0) await onQuarantined(organizationId, quarantined)
    const batchIds = await batchIdsOfDocuments(
      organizationId,
      settled.map((row) => row.id)
    )
    await settleUploadBatches(organizationId, batchIds)
    // A same-name upload is held until now; the people who followed the
    // document hear about the new Fassung once it is readable. Detached:
    // it asks the directory about each person and logs its own failures.
    //
    // A stopped read announces nothing: it is not in the index, so "the new
    // Fassung is here" would be false, and its row is the uploader's own to
    // act on again. Held back is left out for the same reason.
    void announceSettledVersions(
      organizationId,
      settled
        .filter((row) => row.status !== 'quarantined' && row.status !== 'cancelled')
        .map((row) => row.id)
    ).catch((error) => console.warn('[upload-batches] announcing new Fassungen failed:', error))
  } catch (error) {
    console.warn('[upload-batches] settling after reconciliation failed; the sweep retries:', error)
  }
}

/**
 * Complete every given batch that is ready, and tell each uploader once. When
 * the uploader cannot be told, the completion is undone and the error thrown:
 * a completed batch is never settled again, so its item would be lost.
 */
export async function settleUploadBatches(organizationId: string, batchIds: readonly string[]): Promise<UploadBatch[]> {
  const completedAt = new Date()
  const completed = await completeSettledBatches(organizationId, batchIds, completedAt)
  if (completed.length === 0) return completed
  try {
    const emissions = await Promise.all(completed.map((batch) => completionEmission(batch)))
    await emitInboxItems(emissions)
  } catch (error) {
    await reopenCompletedBatches(
      organizationId,
      completed.map((batch) => batch.id),
      completedAt
    )
    throw error
  }
  await startIntakeReadings(organizationId, completed)
  // What ingestion read may sharpen or withdraw the filing suggestion the seal
  // queued; never throws, so it cannot undo the completion either.
  await queueFilingReviewsAfterSettle(organizationId, completed)
  return completed
}

/**
 * A completed batch on a project whose intake is not finished starts a reading
 * of what it brought (ADR-0111). After the uploader was told, and outside the
 * reopen above: a reading that could not be queued must not undo a completion,
 * and the next upload, or „Lesen starten", asks again.
 */
async function startIntakeReadings(organizationId: string, completed: readonly UploadBatch[]): Promise<void> {
  try {
    await queueIntakeReadsAfterUpload(organizationId, completed)
  } catch (error) {
    console.warn('[upload-batches] queueing the intake reading failed; the next upload or a click starts it:', error)
  }
}

/** Where an upload went, as the row's subject: the project's name, or the shelf. */
/**
 * The project's name, the one subject an upload has that is data rather than
 * copy. The Büroablage and a chat get none: the payload is rendered verbatim,
 * so a place name written here would reach every reader in this language.
 */
async function projectNameOf(batch: UploadBatch): Promise<string | null> {
  if (batch.scope !== 'project' || !batch.projectId) return null
  const project = await findProjectInOrg(batch.projectId, batch.organizationId)
  return project?.name ?? null
}

async function completionEmission(batch: UploadBatch): Promise<InboxEmission> {
  const subject = await projectNameOf(batch)
  return {
    organizationId: batch.organizationId,
    recipientUserId: batch.createdBy,
    type: 'upload.completed',
    resourceType: 'upload_batch',
    resourceId: batch.id,
    anchorId: batch.id,
    actorUserId: null,
    groupKey: inboxGroupKey('upload.completed', 'upload_batch', batch.id, batch.id),
    payload: subject ? { subject } : {},
  }
}

/**
 * Who may release or delete this quarantined document: the organization's
 * admins, the project's admins, and for the Büroablage its curators — the
 * same rule `mayReviewQuarantine` applies to a session, asked here about each
 * member of the organization because there is no session to ask
 * (`isQuarantineReviewer`).
 *
 * The directory is the whole roster (`autoPagination`), and each member is
 * asked once. An unreadable directory reads as an empty one, so nobody is
 * notified; that failure is not cached (`loadOrganizationDirectory`).
 */
export async function quarantineReviewersOf(organizationId: string, document: Document): Promise<string[]> {
  const directory = await loadOrganizationDirectory(organizationId)
  const verdicts = await Promise.all(
    [...directory.keys()].map(async (userId) =>
      (await isQuarantineReviewer(organizationId, document, userId)) ? userId : null
    )
  )
  return verdicts.filter((userId): userId is string => userId !== null)
}

/**
 * The content gate quarantined these documents: send its decisions to the
 * audit trail (AI Act), then tell the reviewers.
 */
async function onQuarantined(organizationId: string, documentIds: readonly string[]): Promise<void> {
  await auditOwedQuarantines(organizationId, documentIds)
  const documents = (
    await Promise.all(documentIds.map((id) => findDocumentInOrg(id, organizationId, internalRead('audit'))))
  ).filter(
    (row): row is Document => row !== null
  )
  await notifyQuarantineReviewers(organizationId, documents)
}

/**
 * Tell the reviewers that files wait for them. One collapsed row per reviewer
 * and organization, counted, pointing at the quarantine queue — which is where
 * each file and its reasons are. The row names the newest file and the kind of
 * reason it was held for (`quarantineNoticeVariant`), never a matched value.
 * Each emission goes only to the reviewers of that file, cleared for its
 * project and its folder (`quarantineReviewersOf`), so a row only ever names a
 * file its reader could open in the queue anyway; a reviewer of one project
 * learns nothing of another's.
 */
async function notifyQuarantineReviewers(organizationId: string, documents: readonly Document[]): Promise<void> {
  const emissions: InboxEmission[] = []
  for (const document of documents) {
    for (const reviewer of await quarantineReviewersOf(organizationId, document)) {
      emissions.push({
        organizationId,
        recipientUserId: reviewer,
        type: 'document.quarantined',
        resourceType: 'organization',
        resourceId: organizationId,
        actorUserId: document.createdBy,
        groupKey: inboxGroupKey('document.quarantined', 'organization', organizationId),
        payload: quarantineNoticePayload(document),
      })
    }
  }
  await emitInboxItems(emissions)
}
