/**
 * What each kind of job does when a worker hands it a slice (ADR-0079).
 *
 * A handler reads the job's saved state, does one bounded step of the work and
 * returns the state to save. It never claims, heartbeats or finishes: the runner
 * owns the queue, this owns the work. That split is why a job survives a
 * restart: nothing a handler holds in memory matters, only what it returned.
 *
 * A walk (`reindex_project`, `reingest_failed`, `restore_folder_bin`) runs as
 * the person who asked, in the job's organization. The runner has no session,
 * so the session is built here, and built from what the identity provider says
 * NOW: the payload names who asked, but a job can wait in the queue and a walk
 * spans many slices, and a person who lost their role or left the organization
 * in the meantime must not have it carry on with the rights they had when they
 * clicked. The services the handlers call then check access per document
 * exactly as they do for a request. `purge_binned_chunks` walks as the system,
 * and the other kinds are single steps run as the system (see `./types.ts`).
 */

import 'server-only'
import type { ZodType } from 'zod'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  runBimExtractJob,
  runOfficeRenditionJob,
  runReindexSlice,
  runReingestFailedSlice,
} from '@/lib/documents/service'
import { runPurgeBinnedChunksSlice, runRestoreFolderSlice } from '@/lib/projects/folder-bin-jobs'
import { runReportFilingJob } from '@/lib/tasks/service'
import { isLastAttempt } from './attempts'
import {
  bimExtractPayloadSchema,
  fileResearchReportPayloadSchema,
  officeRenditionPayloadSchema,
  purgeBinnedChunksPayloadSchema,
  reindexProjectPayloadSchema,
  reingestFailedPayloadSchema,
  restoreFolderBinPayloadSchema,
  type BffJobKind,
  type JobAttempt,
  type JobRequester,
  type JobSliceResult,
} from './types'

/**
 * One bounded step of a job: the state it was saved with in, the state to save out.
 * `attempts` is the claims spent so far, this one included.
 */
export type JobHandler = (job: {
  organizationId: string
  payload: unknown
  attempts: number
}) => Promise<JobSliceResult<object>>

/**
 * Tie a payload schema to its slice function, so the two cannot name different
 * payloads. A stored payload that does not parse throws: a row nobody can read
 * is a failed attempt, not something to guess at.
 *
 * The session is the requester's TODAY (`resolvePinnedRequesterSession`: their
 * membership and role now, no access token), resolved before every slice. A
 * requester who is no longer a member of the organization ends the job quietly,
 * as the slices end it for one who lost the project: nothing is retried, because
 * a retry would be refused the same way.
 */
function handler<TPayload extends { requester: JobRequester }>(
  schema: ZodType<TPayload>,
  slice: (session: AuthorizedSession, payload: TPayload) => Promise<JobSliceResult<TPayload>>
): JobHandler {
  return async ({ organizationId, payload }) => {
    const parsed = schema.parse(payload)
    const { userId, email } = parsed.requester
    const session = await resolvePinnedRequesterSession({ userId, email, organizationId })
    if (!session) {
      console.warn(`[jobs] ${userId} is no longer a member of ${organizationId}; ending a job they asked for`)
      return { done: true, payload: parsed }
    }
    return slice(session, parsed)
  }
}

/**
 * A kind that is one step and runs as the system: it takes no session, finishes
 * in the slice it is given, and throws to have the queue retry it. A step whose
 * failure a retry would not change says so itself and returns.
 */
function systemHandler<TPayload extends object>(
  schema: ZodType<TPayload>,
  step: (organizationId: string, payload: TPayload, attempt: JobAttempt) => Promise<void>
): JobHandler {
  return async ({ organizationId, payload, attempts }) => {
    const parsed = schema.parse(payload)
    await step(organizationId, parsed, { last: isLastAttempt(attempts) })
    return { done: true, payload: parsed }
  }
}

/**
 * A walk that runs as the system: sliced like the person's walks, but with no
 * session, because what it finishes must not depend on who asked (see
 * `./types.ts`). It is told whether this is its last attempt, so it can leave
 * the truth behind before the queue gives up on it.
 */
function systemSliceHandler<TPayload extends object>(
  schema: ZodType<TPayload>,
  slice: (organizationId: string, payload: TPayload, attempt: JobAttempt) => Promise<JobSliceResult<TPayload>>
): JobHandler {
  return async ({ organizationId, payload, attempts }) =>
    slice(organizationId, schema.parse(payload), { last: isLastAttempt(attempts) })
}

/** One handler per kind; the record's type makes a kind without one a compile error. */
export const JOB_HANDLERS: Record<BffJobKind, JobHandler> = {
  reindex_project: handler(reindexProjectPayloadSchema, runReindexSlice),
  reingest_failed: handler(reingestFailedPayloadSchema, runReingestFailedSlice),
  restore_folder_bin: handler(restoreFolderBinPayloadSchema, runRestoreFolderSlice),
  purge_binned_chunks: systemSliceHandler(purgeBinnedChunksPayloadSchema, runPurgeBinnedChunksSlice),
  bim_extract: systemHandler(bimExtractPayloadSchema, runBimExtractJob),
  office_rendition: systemHandler(officeRenditionPayloadSchema, runOfficeRenditionJob),
  file_research_report: systemHandler(fileResearchReportPayloadSchema, runReportFilingJob),
}
