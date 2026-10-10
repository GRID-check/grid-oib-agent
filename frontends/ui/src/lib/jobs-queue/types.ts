/**
 * The vocabulary of the BFF job queue (ADR-0079): which kinds of job exist, what
 * a job's payload holds, and who asked for it.
 *
 * A payload is the job's whole state. It carries what was asked for AND how far
 * the job has got, because a job outlives the process that started it: the
 * runner saves the payload after every slice, and whichever worker claims the
 * job next resumes from the stored one. A payload is therefore read back from a
 * database row, never trusted, and every kind states its shape as a schema.
 */

import { z } from 'zod'
import type { AuthorizedSession } from '@/lib/auth/types'
import { BFF_JOB_PRIORITY, type BffJobPriority } from '@/lib/db/schema'

/**
 * The kinds a `bff-jobs` worker knows how to run. A new kind is added here, as a
 * payload schema below and in `./handlers.ts`.
 *
 * `reindex_project`, `reingest_failed` and `restore_folder_bin` walk a set of
 * documents a page per slice and run AS the person who asked (their payload
 * carries a `requester`). `placement_reingest` walks too, as the system: what
 * it re-reads was decided by a change of folder access the person was
 * authorized for, and the rows it takes say so themselves.
 * `purge_binned_chunks` walks as the system as well:
 * it finishes a delete a person already committed, and whether a binned folder
 * stays searchable must not depend on whether that person is still a member.
 * The other three are one bounded step each and run as the system, because the
 * person's permission was checked when the work was requested and what they do
 * afterwards takes no session: parsing a model, converting a file, rendering
 * and filing a report as the run's own pinned requester.
 */
export const BFF_JOB_KINDS = [
  'reindex_project',
  'reingest_failed',
  'placement_reingest',
  'restore_folder_bin',
  'purge_binned_chunks',
  'bim_extract',
  'office_rendition',
  'file_research_report',
  'mail_import',
] as const
export type BffJobKind = (typeof BFF_JOB_KINDS)[number]

export function isBffJobKind(value: string): value is BffJobKind {
  return (BFF_JOB_KINDS as readonly string[]).includes(value)
}

export { BFF_JOB_PRIORITY }
export type { BffJobPriority }

/**
 * The person a job runs on behalf of, as the permission checks need them.
 *
 * The job is authorized when it is enqueued, by the route that took the request.
 * What travels here says WHO asked; the walks that run as a person
 * (`reindex_project`, `reingest_failed`, `restore_folder_bin`) do not trust
 * the rest of it: `handlers.ts` resolves the person's membership and role
 * again before every slice, so a role revoked while the job waited ends it. Only `file_research_report`, a one-step job a
 * reader's request authorizes up front, files on the snapshot. It is NOT a
 * session token. The worker has no access token and nothing here can be
 * replayed against WorkOS; a project or resource check asks WorkOS live, by the
 * membership id, as it does for a request.
 */
export const requesterSchema = z.object({
  userId: z.string().min(1),
  email: z.string(),
  organizationMembershipId: z.string().min(1),
  role: z.string().min(1),
  permissions: z.array(z.string()),
  /**
   * The feature flags the person's session carried, for the one kind that is
   * gated on them when it files a document (`file_research_report`). Optional
   * because a payload stored before it existed has none, and a job that does
   * not file reads nothing from it.
   */
  featureFlags: z.array(z.string()).nullable().optional(),
})
export type JobRequester = z.infer<typeof requesterSchema>

export function requesterOf(session: AuthorizedSession): JobRequester {
  return {
    userId: session.userId,
    email: session.email,
    organizationMembershipId: session.organizationMembershipId,
    role: session.role,
    permissions: session.permissions,
    ...(session.featureFlags ? { featureFlags: session.featureFlags } : {}),
  }
}

/** The session a slice runs as: the requester's identity in the job's organization, with no access token. */
export function sessionOf(requester: JobRequester, organizationId: string): AuthorizedSession {
  return {
    userId: requester.userId,
    email: requester.email,
    name: null,
    accessToken: '',
    organizationId,
    organizationMembershipId: requester.organizationMembershipId,
    role: requester.role,
    permissions: requester.permissions,
    featureFlags: requester.featureFlags ?? null,
  }
}

/** One document-list keyset position (`documents/list-cursor.ts`). */
const cursorSchema = z.object({ createdAt: z.string(), id: z.string() })

/** How many display names of failed documents a job keeps; the count is exact, the names are for the log. */
export const FAILED_NAMES_KEPT = 20

/** What a reindex or a rescan has done so far. */
const countsSchema = z.object({
  queued: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failedNames: z.array(z.string()).max(FAILED_NAMES_KEPT),
})
export type JobCounts = z.infer<typeof countsSchema>

export const emptyCounts = (): JobCounts => ({ queued: 0, skipped: 0, failed: 0, failedNames: [] })

/** Count one failure, keeping the first few names for the log; the count stays exact. */
export function recordJobFailure(counts: JobCounts, name: string): void {
  counts.failed += 1
  if (counts.failedNames.length < FAILED_NAMES_KEPT) counts.failedNames.push(name)
}

/** `reindex_project`: rebuild every document's chunks in one project, a page of documents per slice. */
export const reindexProjectPayloadSchema = z.object({
  projectId: z.string().min(1),
  requester: requesterSchema,
  /** Where the next slice starts; `null` is the first slice. */
  cursor: cursorSchema.nullable(),
  counts: countsSchema,
})
export type ReindexProjectPayload = z.infer<typeof reindexProjectPayloadSchema>

/** `reingest_failed`: send every failed ingestion in the organization back through the pipeline. */
export const reingestFailedPayloadSchema = z.object({
  requester: requesterSchema,
  /** Position in the failed set (oldest first); `null` is the first slice. */
  cursor: cursorSchema.nullable(),
  counts: countsSchema,
})
export type ReingestFailedPayload = z.infer<typeof reingestFailedPayloadSchema>

/**
 * `placement_reingest`: re-read the documents collection placement moved in one
 * project (ADR-0087), a page per slice. Its whole state is the project: the
 * rows it takes are marked on the row (`documents/placement-repository.ts`),
 * so a job already queued serves rows marked after it.
 */
export const placementReingestPayloadSchema = z.object({
  projectId: z.string().min(1),
})
export type PlacementReingestPayload = z.infer<typeof placementReingestPayloadSchema>

/**
 * `restore_folder_bin`: read the documents of a folder restored from the
 * Papierkorb back into the index (ADR-0088), a page per slice.
 *
 * The restore stamps every document it brings back `processing` with this
 * job's id (`metadata.bffJobId`) in the transaction that takes the folder out
 * of the bin, so `jobId` is both the job and the mark: a slice reads only the
 * rows still carrying it, and a row this job never reaches (the requester lost
 * access, the job died) is one the stuck-processing sweep recovers.
 */
export const restoreFolderBinPayloadSchema = z.object({
  projectId: z.string().min(1),
  /** The restored folder (the bin entry's root). */
  folderId: z.string().min(1),
  /** This job's own id, stamped on the rows it owns. */
  jobId: z.string().uuid(),
  requester: requesterSchema,
  /** The last document id handled; `null` is the first slice. */
  cursor: z.string().nullable(),
  counts: countsSchema,
})
export type RestoreFolderBinPayload = z.infer<typeof restoreFolderBinPayloadSchema>

/**
 * `purge_binned_chunks`: finish the chunk purge of a folder delete whose
 * request did not (ADR-0088). Queued in the transaction that puts the folder in
 * the bin, not before `BIN_PURGE_TAKEOVER_MS`; the request deletes it once its
 * own purge is confirmed, so it runs only when the request died half way.
 *
 * `entryId` is the bin entry's `deletion_queue` row: the job acts only while
 * that row is still pending and has no `chunksPurgedAt`, so a restore, a purge
 * or a second delete of the same folder ends it. `requester` is who deleted,
 * kept for the one case the job undoes the delete (the index refused on its
 * last attempt) and the restore job it then queues runs as them.
 */
export const purgeBinnedChunksPayloadSchema = z.object({
  projectId: z.string().min(1),
  folderId: z.string().min(1),
  entryId: z.string().min(1),
  requester: requesterSchema,
  /** The last document id purged; `null` is the first slice. */
  cursor: z.string().nullable(),
  /** Documents purged so far, recorded on the bin entry at the end. */
  documents: z.number().int().nonnegative(),
})
export type PurgeBinnedChunksPayload = z.infer<typeof purgeBinnedChunksPayloadSchema>

/**
 * A stored document to run background work for: what `dispatchDocument` was
 * handed, which is all the job needs because it re-reads the row for the rest.
 * Both document kinds carry it, so a queued job and the call that would have
 * run in the request cannot disagree about what a document is.
 */
const documentWorkPayloadSchema = z.object({
  projectId: z.string().nullable(),
  documentId: z.string().min(1),
  filename: z.string().min(1),
  storageKey: z.string().min(1),
  storageBucket: z.string().nullable(),
  collectionName: z.string().min(1),
  folderPath: z.string().nullable().optional(),
  /** Which version these bytes are; a machine's document is indexed only as its published one. */
  versionId: z.string().nullable().optional(),
  priority: z.enum(['interactive', 'bulk']).optional(),
})

/** `bim_extract`: parse an IFC model into the structured index, then ingest its digest. */
export const bimExtractPayloadSchema = documentWorkPayloadSchema
export type BimExtractPayload = z.infer<typeof bimExtractPayloadSchema>

/**
 * `office_rendition`: convert a Word, presentation or spreadsheet file to its
 * PDF rendition, then ingest it. `fileName` is the ROW's name, which the join
 * key the backend files the chunks under.
 */
export const officeRenditionPayloadSchema = documentWorkPayloadSchema.extend({
  fileName: z.string().min(1),
  provenance: z
    .object({
      authored_by: z.literal('agent'),
      approved_by: z.string().nullable(),
      approved_at: z.string().nullable(),
      producer: z.string().nullable(),
    })
    .nullable()
    .optional(),
})
export type OfficeRenditionPayload = z.infer<typeof officeRenditionPayloadSchema>

/**
 * `file_research_report`: render a finished deep-research run's report as a PDF
 * and file it into the project.
 *
 * The report travels in the payload because the job outlives the callback that
 * handed it over, and nothing else holds it for certain (the backend's job
 * store forgets a run after a day). `taskRunId` is the `task_runs` row whose
 * `filing_status` follows the job; null when only a reader's request asked, for
 * a run that has no row. `requester` is that reader's identity, and null means
 * the run's own pinned requester files it, resolved when the job runs.
 */
export const fileResearchReportPayloadSchema = z.object({
  /** The backend job id: the document's idempotency key. */
  runId: z.string().min(1),
  projectId: z.string().min(1),
  report: z.string().min(1),
  cards: z.array(z.unknown()).optional(),
  taskRunId: z.string().nullable(),
  requester: requesterSchema.nullable(),
})
export type FileResearchReportPayload = z.infer<typeof fileResearchReportPayloadSchema>

/**
 * `mail_import`: file a staged Outlook archive into its project (ADR-0085), a
 * time budget of mails per slice, as the person who started it. Its progress
 * lives on the `mail_imports` row, not here, because it advances per mail and
 * a slice can die between two of them.
 */
export const mailImportPayloadSchema = z.object({
  importId: z.string().uuid(),
  projectId: z.string().uuid(),
  requester: requesterSchema,
})
export type MailImportPayload = z.infer<typeof mailImportPayloadSchema>

/** What a one-step job is told about the attempt it is running. */
export interface JobAttempt {
  /** True when a failure now leaves the job dead, so the work must leave its own truth behind. */
  last: boolean
}

/** What one slice of any job answers: whether the job is finished, and the state to save either way. */
export interface JobSliceResult<TPayload> {
  done: boolean
  payload: TPayload
}
