/**
 * The content gate's decision, in the audit trail (ADR-0085; AI Act).
 *
 * Quarantining is the one screening decision Piloti makes without a person:
 * the ingest job's rule-based gate stops the file before any model reads it.
 * A reviewer's release was audited and the decision it undid was not, so the
 * trail could say who let a file through but never that the system held it.
 *
 * At least once, and once per decision. The status write that records a
 * quarantine also records the decision, keyed on its dispatch, in
 * `document_quarantine_decisions` (`setDocumentReconciledStatus`), so a
 * decision cannot exist without its row. This sends a row to the trail and
 * then marks it audited: the read that moved the row sends it at once
 * (`upload-batches/settle.ts`), and the upload sweep sends whatever is still
 * owed a minute later (`upload-batches/sweep.ts`). A send that fails, or a
 * process that dies before the mark, leaves it owed. A row sent twice is one
 * event: the WorkOS idempotency key is the row's id, and the event is built
 * from the row alone, its time the decision's.
 *
 * The actor is {@link SYSTEM_ACTORS.uploadScreening}; the uploader rides as
 * metadata. Kinds and terms only, never content. The file's name goes only
 * where every member of its project may read the folder it was filed in, as
 * for every event that names a document (`audit/document-names.ts`).
 */

import 'server-only'
import { auditLogsEnabled, recordAuditEventOrThrow, SYSTEM_ACTORS } from '@/lib/audit/service'
import type { DocumentQuarantineDecision } from '@/lib/db/schema'
import {
  listOwedQuarantineDecisions,
  listOwedQuarantineDecisionsBetween,
  markQuarantineDecisionAudited,
} from './repository'

/** Younger than this, a decision is the moving read's to send; the sweep leaves it alone. */
export const QUARANTINE_AUDIT_GRACE_MS = 60_000
/** Older than this, an owed decision is left alone: the trail has been off, or refusing it, for a week. */
const QUARANTINE_AUDIT_WINDOW_MS = 7 * 24 * 60 * 60_000
/** Decisions one sweep sends. */
export const QUARANTINE_AUDIT_SWEEP_LIMIT = 50

/** The WorkOS idempotency key of one decision's event. */
export const quarantineEventKey = (decisionId: string): string =>
  `document.quarantined:${decisionId}`

/**
 * Send one decision to the trail and mark it audited. Returns whether it was
 * sent; a failure is logged and leaves it owed. Never throws.
 */
export async function auditQuarantineDecision(
  decision: DocumentQuarantineDecision
): Promise<boolean> {
  try {
    await recordAuditEventOrThrow({
      organizationId: decision.organizationId,
      actor: { userId: SYSTEM_ACTORS.uploadScreening, email: null },
      action: 'document.quarantined',
      targetType: 'document',
      targetId: decision.documentId,
      metadata: {
        projectId: decision.projectId ?? '',
        filename: decision.filename.slice(0, 200),
        scope: decision.scope,
        reasons: decision.reasons,
        checked: decision.checked,
        uploadedBy: decision.uploadedBy,
        jobId: decision.jobId ?? '',
      },
      // Where it was filed when the gate decided: the trail withholds the name
      // of a file under a folder not every project member may read (ADR-0086).
      filedIn: decision.projectId ? { projectId: decision.projectId, folderId: decision.folderId } : null,
      occurredAt: new Date(decision.decidedAt),
      idempotencyKey: quarantineEventKey(decision.id),
    })
    await markQuarantineDecisionAudited(decision.organizationId, decision.id, new Date())
    return true
  } catch (error) {
    console.warn(
      `[quarantine-audit] decision ${decision.id} stays owed; the upload sweep sends it again:`,
      error
    )
    return false
  }
}

/**
 * Send the owed decisions about these documents. A deployment that keeps no
 * trail (`GRID_AUDIT_LOGS_ENABLED` off) sends nothing and marks nothing, so
 * turning the trail on later still finds the recent ones. Never throws.
 */
export async function auditOwedQuarantines(
  organizationId: string,
  documentIds: readonly string[]
): Promise<void> {
  if (!auditLogsEnabled()) return
  try {
    const owed = await listOwedQuarantineDecisions(organizationId, documentIds)
    await Promise.all(owed.map((decision) => auditQuarantineDecision(decision)))
  } catch (error) {
    console.warn(
      '[quarantine-audit] could not read the owed decisions; the upload sweep sends them:',
      error
    )
  }
}

/**
 * The sweep's half (`upload-batches/sweep.ts`): send what is still owed after
 * {@link QUARANTINE_AUDIT_GRACE_MS}, across organizations. Returns how many it
 * sent. Throws only if the owed decisions cannot be listed.
 */
export async function sweepOwedQuarantines(now: Date = new Date()): Promise<number> {
  if (!auditLogsEnabled()) return 0
  const owed = await listOwedQuarantineDecisionsBetween(
    new Date(now.getTime() - QUARANTINE_AUDIT_WINDOW_MS),
    new Date(now.getTime() - QUARANTINE_AUDIT_GRACE_MS),
    QUARANTINE_AUDIT_SWEEP_LIMIT
  )
  let sent = 0
  for (const decision of owed) {
    if (await auditQuarantineDecision(decision)) sent += 1
  }
  return sent
}
