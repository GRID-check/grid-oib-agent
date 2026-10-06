/**
 * The vocabulary of the BFF job queue (ADR-0078): which kinds of job exist, what
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

/** The kinds a `bff-jobs` worker knows how to run. A new kind is added here and in `./handlers.ts`. */
export const BFF_JOB_KINDS = ['reindex_project', 'reingest_failed'] as const
export type BffJobKind = (typeof BFF_JOB_KINDS)[number]

export function isBffJobKind(value: string): value is BffJobKind {
  return (BFF_JOB_KINDS as readonly string[]).includes(value)
}

export { BFF_JOB_PRIORITY }
export type { BffJobPriority }

/**
 * The person a job runs on behalf of, as the permission checks need them.
 *
 * The job is authorized when it is enqueued, by the route that took the request;
 * what travels here is what the per-document checks that follow still read: who,
 * in which membership, holding which organization permissions. It is NOT a
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
})
export type JobRequester = z.infer<typeof requesterSchema>

export function requesterOf(session: AuthorizedSession): JobRequester {
  return {
    userId: session.userId,
    email: session.email,
    organizationMembershipId: session.organizationMembershipId,
    role: session.role,
    permissions: session.permissions,
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
    featureFlags: null,
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

/** What one slice of any job answers: whether the job is finished, and the state to save either way. */
export interface JobSliceResult<TPayload> {
  done: boolean
  payload: TPayload
}
