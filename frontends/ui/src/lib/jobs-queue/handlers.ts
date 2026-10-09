/**
 * What each kind of job does when a worker hands it a slice (ADR-0079).
 *
 * A handler reads the job's saved state, does one bounded step of the work and
 * returns the state to save. It never claims, heartbeats or finishes: the runner
 * owns the queue, this owns the work. That split is why a job survives a
 * restart: nothing a handler holds in memory matters, only what it returned.
 *
 * A walk (`reindex_project`, `reingest_failed`) runs as the person who asked, in
 * the job's organization. The runner has no session, so the session is built
 * here, and built from what the identity provider says NOW: the payload names
 * who asked, but a job can wait in the queue and a walk spans many slices, and
 * a person who lost their role or left the organization in the meantime must
 * not have it carry on with the rights they had when they clicked. The services
 * the handlers call then check access per document exactly as they do for a
 * request. `placement_reingest` walks as the system, and the other kinds are
 * single steps run as the system (see `./types.ts`).
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
import { runInboundMailJob } from '@/lib/inbound-mail/job'
import { runPlacementReingestSlice } from '@/lib/projects/collection-placement'
import { runMailImportSlice } from '@/lib/mail-import/job'
import { runReportFilingJob } from '@/lib/tasks/service'
import { isLastAttempt } from './attempts'
import {
  bimExtractPayloadSchema,
  fileResearchReportPayloadSchema,
  inboundMailPayloadSchema,
  mailImportPayloadSchema,
  officeRenditionPayloadSchema,
  placementReingestPayloadSchema,
  reindexProjectPayloadSchema,
  reingestFailedPayloadSchema,
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
 * A walk that runs as the system: no session, a slice at a time, and the state
 * it returns saved for the next one. A throw is a failed attempt, as for any
 * kind.
 */
function systemWalk<TPayload extends object>(
  schema: ZodType<TPayload>,
  slice: (organizationId: string, payload: TPayload) => Promise<JobSliceResult<TPayload>>
): JobHandler {
  return async ({ organizationId, payload }) => slice(organizationId, schema.parse(payload))
}

/**
 * The mail import's walk. Not {@link handler}: a requester who left must END
 * the import with a reason, because it is a row the person sees, not a quiet
 * no-op. Its retries are its own (`lib/mail-import/job.ts`), not the queue's.
 */
const mailImportHandler: JobHandler = async ({ organizationId, payload }) => {
  const parsed = mailImportPayloadSchema.parse(payload)
  const { userId, email } = parsed.requester
  const session = await resolvePinnedRequesterSession({ userId, email, organizationId })
  return runMailImportSlice(session, parsed, organizationId)
}

/**
 * A mail a project's address accepted. Not {@link systemHandler}: its retries
 * are its own, like the mail import's (`lib/inbound-mail/job.ts`), because a
 * mail must survive an outage of most of a day and the queue's backoff is
 * minutes. The job hands the delivery on to a fresh job and always ends.
 */
const inboundMailHandler: JobHandler = async ({ organizationId, payload }) => {
  const parsed = inboundMailPayloadSchema.parse(payload)
  await runInboundMailJob(organizationId, parsed)
  return { done: true, payload: parsed }
}

/** One handler per kind; the record's type makes a kind without one a compile error. */
export const JOB_HANDLERS: Record<BffJobKind, JobHandler> = {
  reindex_project: handler(reindexProjectPayloadSchema, runReindexSlice),
  reingest_failed: handler(reingestFailedPayloadSchema, runReingestFailedSlice),
  placement_reingest: systemWalk(placementReingestPayloadSchema, runPlacementReingestSlice),
  bim_extract: systemHandler(bimExtractPayloadSchema, runBimExtractJob),
  office_rendition: systemHandler(officeRenditionPayloadSchema, runOfficeRenditionJob),
  file_research_report: systemHandler(fileResearchReportPayloadSchema, runReportFilingJob),
  mail_import: mailImportHandler,
  inbound_mail: inboundMailHandler,
}
