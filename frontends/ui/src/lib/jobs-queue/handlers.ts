/**
 * What each kind of job does when a worker hands it a slice (ADR-0078).
 *
 * A handler reads the job's saved state, does one bounded step of the work and
 * returns the state to save. It never claims, heartbeats or finishes: the runner
 * owns the queue, this owns the work. That split is why a job survives a
 * restart: nothing a handler holds in memory matters, only what it returned.
 *
 * A walk (`reindex_project`, `reingest_failed`) runs as the person who asked, in
 * the job's organization. The runner has no session, so the session is built
 * here from the requester stored in the payload, and the services the handlers
 * call check access per document exactly as they do for a request. The other
 * kinds are single steps run as the system (see `./types.ts`).
 */

import 'server-only'
import type { ZodType } from 'zod'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  runBimExtractJob,
  runOfficeRenditionJob,
  runReindexSlice,
  runReingestFailedSlice,
} from '@/lib/documents/service'
import { runReportFilingJob } from '@/lib/tasks/service'
import { isLastAttempt } from './attempts'
import {
  bimExtractPayloadSchema,
  fileResearchReportPayloadSchema,
  officeRenditionPayloadSchema,
  reindexProjectPayloadSchema,
  reingestFailedPayloadSchema,
  sessionOf,
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
 */
function handler<TPayload extends { requester: JobRequester }>(
  schema: ZodType<TPayload>,
  slice: (session: AuthorizedSession, payload: TPayload) => Promise<JobSliceResult<TPayload>>
): JobHandler {
  return async ({ organizationId, payload }) => {
    const parsed = schema.parse(payload)
    return slice(sessionOf(parsed.requester, organizationId), parsed)
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

/** One handler per kind; the record's type makes a kind without one a compile error. */
export const JOB_HANDLERS: Record<BffJobKind, JobHandler> = {
  reindex_project: handler(reindexProjectPayloadSchema, runReindexSlice),
  reingest_failed: handler(reingestFailedPayloadSchema, runReingestFailedSlice),
  bim_extract: systemHandler(bimExtractPayloadSchema, runBimExtractJob),
  office_rendition: systemHandler(officeRenditionPayloadSchema, runOfficeRenditionJob),
  file_research_report: systemHandler(fileResearchReportPayloadSchema, runReportFilingJob),
}
