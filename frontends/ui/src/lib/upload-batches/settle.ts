/**
 * What happens when documents come to rest (ADR-0077): their upload completes
 * and its uploader is told, and a quarantined file's reviewers are told.
 *
 * Called by status reconciliation for every row it moved to a terminal status,
 * by the seal, and by the sweep. Never throws into its caller: a read that
 * reconciled a status must not fail because a notification could not be sent,
 * and the guarded `completed_at` means a later settle can still emit.
 *
 * Imports nothing from reconciliation, which imports this.
 */

import 'server-only'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { orgRoleHoldsPermission } from '@/lib/authz/org-role-permissions'
import { resolveSubjectMembership, userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { Document, UploadBatch } from '@/lib/db/schema'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, type InboxEmission } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { batchIdsOfDocuments, completeSettledBatches } from './repository'

export interface SettledDocument {
  id: string
  status: string
}

/** Settle after reconciliation moved these rows. Never throws. */
export async function onDocumentsSettled(organizationId: string, settled: readonly SettledDocument[]): Promise<void> {
  if (settled.length === 0) return
  try {
    const quarantined = settled.filter((row) => row.status === 'quarantined').map((row) => row.id)
    if (quarantined.length > 0) await notifyQuarantineReviewers(organizationId, quarantined)
    const batchIds = await batchIdsOfDocuments(
      organizationId,
      settled.map((row) => row.id)
    )
    await settleUploadBatches(organizationId, batchIds)
  } catch (error) {
    console.warn('[upload-batches] settling after reconciliation failed; the sweep retries:', error)
  }
}

/** Complete every given batch that is ready, and tell each uploader once. */
export async function settleUploadBatches(organizationId: string, batchIds: readonly string[]): Promise<UploadBatch[]> {
  const completed = await completeSettledBatches(organizationId, batchIds, new Date())
  if (completed.length === 0) return completed
  const emissions = await Promise.all(completed.map((batch) => completionEmission(batch)))
  await emitInboxItems(emissions)
  return completed
}

/** Where an upload went, as the row's subject: the project's name, or the shelf. */
async function placeOf(batch: UploadBatch): Promise<string> {
  if (batch.scope === 'archiv') return 'Archiv'
  if (batch.scope === 'session') return 'Chat'
  const project = batch.projectId ? await findProjectInOrg(batch.projectId, batch.organizationId) : null
  return project?.name ?? 'Projekt'
}

async function completionEmission(batch: UploadBatch): Promise<InboxEmission> {
  return {
    organizationId: batch.organizationId,
    recipientUserId: batch.createdBy,
    type: 'upload.completed',
    resourceType: 'upload_batch',
    resourceId: batch.id,
    anchorId: batch.id,
    actorUserId: null,
    groupKey: inboxGroupKey('upload.completed', 'upload_batch', batch.id, batch.id),
    payload: { subject: await placeOf(batch) },
  }
}

/**
 * Who may release or delete this quarantined document: the organization's
 * admins, the project's admins, and for the Büroablage its curators — the
 * same rule `mayReviewQuarantine` applies to a session, asked here about each
 * member of the organization because there is no session to ask.
 *
 * Bounded by the directory's first page, as the storage alert is, and for the
 * same reason (`lib/storage/alerts.ts`): the reviewers are a small set.
 */
async function reviewersOf(organizationId: string, document: Document): Promise<string[]> {
  const directory = await loadOrganizationDirectory(organizationId)
  const verdicts = await Promise.all(
    [...directory.keys()].map(async (userId) => {
      const membership = await resolveSubjectMembership(organizationId, userId)
      if (!membership) return null
      if (await orgRoleHoldsPermission(membership.role, ORG_PERMISSIONS.projectsAdminister, organizationId)) return userId
      if (document.scope === 'archiv') {
        return (await orgRoleHoldsPermission(membership.role, ORG_PERMISSIONS.archivManage, organizationId)) ? userId : null
      }
      if (document.scope !== 'project' || !document.projectId) return null
      const manages = await userHoldsProjectPermission({ organizationId }, document.projectId, userId, 'project:manage')
      return manages ? userId : null
    })
  )
  return verdicts.filter((userId): userId is string => userId !== null)
}

/**
 * Tell the reviewers that files wait for them. One collapsed row per reviewer
 * and organization, counted, pointing at the quarantine queue — which is where
 * each file and its reasons are, for the people allowed to see them. The row
 * names no file: a reviewer of one project must not learn another project's
 * file names from a badge.
 */
async function notifyQuarantineReviewers(organizationId: string, documentIds: readonly string[]): Promise<void> {
  const documents = (await Promise.all(documentIds.map((id) => findDocumentInOrg(id, organizationId)))).filter(
    (row): row is Document => row !== null
  )
  const emissions: InboxEmission[] = []
  for (const document of documents) {
    for (const reviewer of await reviewersOf(organizationId, document)) {
      emissions.push({
        organizationId,
        recipientUserId: reviewer,
        type: 'document.quarantined',
        resourceType: 'organization',
        resourceId: organizationId,
        actorUserId: document.createdBy,
        groupKey: inboxGroupKey('document.quarantined', 'organization', organizationId),
      })
    }
  }
  await emitInboxItems(emissions)
}
