/**
 * Upload batches: one upload gesture, from the browser's first request to the
 * moment everything it brought in has been read (migration 0110, ADR-0086).
 *
 *   open    → the browser, before it sends a file (`POST /api/upload-batches`)
 *   stamp   → each upload names the batch; the document row carries its id
 *   seal    → the browser, after its last request (`POST …/[id]/seal`)
 *   settle  → reconciliation, once no document of a sealed batch is in flight
 *             (`./settle`), which tells the uploader in their inbox
 *   summary → what arrived, where, what it is, what was held back and why
 *
 * The summary is the uploader's. It names what the office's screening kept on
 * their machine only by term and count: those files never reached the server.
 */

import 'server-only'
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canManageArchiv } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Document, UploadBatch, UploadBatchExclusion, UploadBatchScope } from '@/lib/db/schema'
import { documentStatusFacts } from '@/lib/documents/document-status'
import { reconcileDocumentStatuses, type DocumentMetadata } from '@/lib/documents/reconcile-status'
import { findFolderPathsInProject } from '@/lib/documents/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { parseQuarantine, type QuarantineVerdict } from '@/lib/upload-screening/quarantine'
import {
  countBatchDocumentsByStatus,
  findUploadBatch,
  insertUploadBatch,
  listBatchDocuments,
  listProjectUploadBatches,
  sealUploadBatch,
} from './repository'

/** The shelves an upload can go to; re-stated here so a route needs nothing from the db layer. */
export { UPLOAD_BATCH_SCOPES } from '@/lib/db/schema'

/** Most files one batch may announce. Mirrors the CHECK in migration 0110. */
export const UPLOAD_BATCH_MAX_FILES = 10_000

export interface OpenUploadBatchInput {
  id: string
  scope: UploadBatchScope
  projectId: string | null
  conversationId: string | null
  expectedCount: number
  excluded: UploadBatchExclusion[]
}

/**
 * Open a batch for the session's upload. Authorized as the upload itself will
 * be: a project upload needs document write access, the Büroablage its
 * curators. A chat attachment's batch needs no more than the session, because
 * every upload into the chat is authorized on its own and the batch grants
 * nothing.
 */
export async function openUploadBatch(session: AuthorizedSession, input: OpenUploadBatchInput): Promise<void> {
  if (input.scope === 'project') {
    if (!input.projectId) throw new BadRequestError('A project upload names its project')
    await requireProjectAccess(session, input.projectId, ['project:documents:write', 'project:edit'])
  } else if (input.scope === 'archiv' && !canManageArchiv(session)) {
    throw new NotFoundError('Upload not found')
  }
  await insertUploadBatch({
    id: input.id,
    organizationId: session.organizationId,
    createdBy: session.userId,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId : null,
    conversationId: input.scope === 'session' ? input.conversationId : null,
    expectedCount: input.expectedCount,
    excluded: input.excluded,
  })
}

/** The session's own batch, or null. Another member's batch answers like a missing one. */
export async function findOwnUploadBatch(session: AuthorizedSession, batchId: string): Promise<UploadBatch | null> {
  const batch = await findUploadBatch(session.organizationId, batchId)
  return batch && batch.createdBy === session.userId ? batch : null
}

/**
 * The batch id an upload request may carry, or null when it may not carry
 * this one. An invalid id never fails the upload: the file is what the person
 * asked for, and the summary is a courtesy. It is ignored instead when the
 * batch is someone else's, sealed already, or for another shelf.
 */
export async function acceptedUploadBatchId(
  session: AuthorizedSession,
  rawId: unknown,
  shelf: { scope: UploadBatchScope; projectId: string | null }
): Promise<string | null> {
  if (typeof rawId !== 'string' || !UUID_PATTERN.test(rawId)) return null
  const batch = await findOwnUploadBatch(session, rawId).catch(() => null)
  if (!batch || batch.sealedAt || batch.scope !== shelf.scope) return null
  if (shelf.scope === 'project' && batch.projectId !== shelf.projectId) return null
  return batch.id
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The multipart field an upload names its batch in; anything but a uuid is no batch. */
export function readUploadBatchId(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}

/** Seal the session's batch once its last request has answered. Idempotent for a sealed batch. */
export async function sealOwnUploadBatch(
  session: AuthorizedSession,
  batchId: string,
  counts: { unchanged: number; failed: number }
): Promise<void> {
  const batch = await findOwnUploadBatch(session, batchId)
  if (!batch) throw new NotFoundError('Upload not found')
  if (batch.sealedAt) return
  const sealed = await sealUploadBatch(session.organizationId, batchId, session.userId, counts, new Date())
  if (!sealed) throw new ConflictError('The upload changed while it was being sealed')
  // A batch whose documents all finished before the seal arrived completes
  // here rather than waiting for a reader or the sweep.
  const { settleUploadBatches } = await import('./settle')
  await settleUploadBatches(session.organizationId, [batchId])
}

/** What one document of an upload became, as the summary shows it. */
export interface UploadSummaryDocument {
  id: string
  filename: string
  displayName: string | null
  folderPath: string | null
  status: string
  /** The status family, so the client need not re-derive it. */
  outcome: 'ready' | 'reading' | 'quarantined' | 'failed' | 'stored'
  screening: Document['screeningOutcome']
  quarantine: QuarantineVerdict | null
  errorMessage: string | null
  summary: string | null
  tags: string[]
  pageCount: number | null
}

export interface UploadSummary {
  id: string
  scope: UploadBatchScope
  projectId: string | null
  conversationId: string | null
  createdAt: string
  sealedAt: string | null
  completedAt: string | null
  expectedCount: number
  unchangedCount: number
  failedCount: number
  excluded: UploadBatchExclusion[]
  documents: UploadSummaryDocument[]
}

function outcomeOf(status: string): UploadSummaryDocument['outcome'] {
  if (status === 'quarantined') return 'quarantined'
  const facts = documentStatusFacts(status)
  if (!facts) return 'stored'
  if (facts.phase === 'in-flight') return 'reading'
  if (facts.variant === 'success') return 'ready'
  if (facts.variant === 'destructive') return 'failed'
  return 'stored'
}

type EnrichedDocument = Document & DocumentMetadata

function toSummaryDocument(row: EnrichedDocument, folderPaths: Map<string, string>): UploadSummaryDocument {
  return {
    id: row.id,
    filename: row.filename,
    displayName: row.displayName ?? null,
    folderPath: row.folderId ? (folderPaths.get(row.folderId) ?? null) : null,
    status: row.status,
    outcome: outcomeOf(row.status),
    screening: row.screeningOutcome,
    quarantine: parseQuarantine(row.errorMessage),
    // A quarantine verdict is shown as reasons, not as an error string.
    errorMessage: row.status === 'quarantined' ? null : row.errorMessage,
    summary: row.summary ?? null,
    tags: row.tags ?? [],
    pageCount: row.pageCount ?? null,
  }
}

/**
 * The uploader's summary of one upload. Reads go through status
 * reconciliation, so opening the summary is itself a reader that can settle
 * the batch, and the summary and tags come from the same enrichment the file
 * list uses.
 */
export async function getUploadSummary(session: AuthorizedSession, batchId: string): Promise<UploadSummary> {
  const batch = await findOwnUploadBatch(session, batchId)
  if (!batch) throw new NotFoundError('Upload not found')
  const rows = await listBatchDocuments(session.organizationId, batchId)
  const enriched = await reconcileDocumentStatuses(rows, session.organizationId)
  const folderIds = [...new Set(enriched.map((row) => row.folderId).filter((id): id is string => !!id))]
  const folderPaths =
    batch.projectId && folderIds.length > 0
      ? await findFolderPathsInProject(folderIds, batch.projectId, session.organizationId)
      : new Map<string, string>()
  const fresh = await findOwnUploadBatch(session, batchId)
  return {
    id: batch.id,
    scope: batch.scope,
    projectId: batch.projectId,
    conversationId: batch.conversationId,
    createdAt: new Date(batch.createdAt).toISOString(),
    sealedAt: batch.sealedAt ? new Date(batch.sealedAt).toISOString() : null,
    completedAt: fresh?.completedAt ? new Date(fresh.completedAt).toISOString() : null,
    expectedCount: batch.expectedCount,
    unchangedCount: batch.unchangedCount,
    failedCount: batch.failedCount,
    excluded: batch.excluded,
    documents: enriched.map((row) => toSummaryDocument(row, folderPaths)),
  }
}

/** One row of a project's upload history (ticket „Verlauf/Protokoll"). */
export interface UploadHistoryEntry {
  id: string
  createdBy: string
  /** The uploader's display name from the organization directory; null when they have left it. */
  createdByName: string | null
  createdAt: string
  completedAt: string | null
  expectedCount: number
  unchangedCount: number
  failedCount: number
  excludedCount: number
  counts: Record<UploadSummaryDocument['outcome'], number>
}

/**
 * A project's uploads, newest first. Readable by anyone who can open the
 * project: it says who brought how much in when, and the per-file detail stays
 * in each uploader's summary.
 */
export async function listProjectUploadHistory(
  session: AuthorizedSession,
  projectId: string
): Promise<UploadHistoryEntry[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  const batches = await listProjectUploadBatches(session.organizationId, projectId)
  const [counts, directory] = await Promise.all([
    countBatchDocumentsByStatus(
      session.organizationId,
      batches.map((batch) => batch.id)
    ),
    loadOrganizationDirectory(session.organizationId),
  ])
  return batches.map((batch) => {
    const tally: UploadHistoryEntry['counts'] = { ready: 0, reading: 0, quarantined: 0, failed: 0, stored: 0 }
    for (const row of counts) if (row.batchId === batch.id) tally[outcomeOf(row.status)] += row.count
    return {
      id: batch.id,
      createdBy: batch.createdBy,
      createdByName: directory.get(batch.createdBy)?.name ?? null,
      createdAt: new Date(batch.createdAt).toISOString(),
      completedAt: batch.completedAt ? new Date(batch.completedAt).toISOString() : null,
      expectedCount: batch.expectedCount,
      unchangedCount: batch.unchangedCount,
      failedCount: batch.failedCount,
      excludedCount: batch.excluded.reduce((sum, entry) => sum + entry.count, 0),
      counts: tally,
    }
  })
}
